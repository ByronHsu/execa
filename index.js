'use strict';
const path = require('path');
const childProcess = require('child_process');
const util = require('util');
const crossSpawn = require('cross-spawn');
const stripEof = require('strip-eof');
const npmRunPath = require('npm-run-path');
const isStream = require('is-stream');
const _getStream = require('get-stream');
const pFinally = require('p-finally');
const onExit = require('signal-exit');
const errname = require('./lib/errname');
const stdio = require('./lib/stdio');

const TEN_MEGABYTES = 1000 * 1000 * 10;

function handleArgs(cmd, args, opts) {
	let parsed;

	opts = Object.assign({
		extendEnv: true,
		env: {}
	}, opts);

	if (opts.extendEnv) {
		opts.env = Object.assign({}, process.env, opts.env);
	}

	if (opts.__winShell === true) {
		delete opts.__winShell;
		parsed = {
			command: cmd,
			args,
			options: opts,
			file: cmd,
			original: {
				cmd,
				args
			}
		};
	} else {
		parsed = crossSpawn._parse(cmd, args, opts);
	}

	opts = Object.assign({
		maxBuffer: TEN_MEGABYTES,
		stripEof: true,
		preferLocal: true,
		localDir: parsed.options.cwd || process.cwd(),
		encoding: 'utf8',
		reject: true,
		cleanup: true
	}, parsed.options);

	opts.stdio = stdio(opts);

	if (opts.preferLocal) {
		opts.env = npmRunPath.env(Object.assign({}, opts, {cwd: opts.localDir}));
	}

	if (opts.detached) {
		// #115
		opts.cleanup = false;
	}

	if (process.platform === 'win32' && path.basename(parsed.command) === 'cmd.exe') {
		// #116
		parsed.args.unshift('/q');
	}

	return {
		cmd: parsed.command,
		args: parsed.args,
		opts,
		parsed
	};
}

function handleInput(spawned, opts) {
	const input = opts.input;

	if (input === null || input === undefined) {
		return;
	}

	if (isStream(input)) {
		input.pipe(spawned.stdin);
	} else {
		spawned.stdin.end(input);
	}
}

function handleOutput(opts, val) {
	if (val && opts.stripEof) {
		val = stripEof(val);
	}

	return val;
}

function handleShell(fn, cmd, opts) {
	let file = '/bin/sh';
	let args = ['-c', cmd];

	opts = Object.assign({}, opts);

	if (process.platform === 'win32') {
		opts.__winShell = true;
		file = process.env.comspec || 'cmd.exe';
		args = ['/s', '/c', `"${cmd}"`];
		opts.windowsVerbatimArguments = true;
	}

	if (opts.shell) {
		file = opts.shell;
		delete opts.shell;
	}

	return fn(file, args, opts);
}

function getStream(process, stream, encoding, maxBuffer) {
	if (!process[stream]) {
		return null;
	}

	let ret;

	if (encoding) {
		ret = _getStream(process[stream], {
			encoding,
			maxBuffer
		});
	} else {
		ret = _getStream.buffer(process[stream], {maxBuffer});
	}

	return ret.catch(err => {
		err.stream = stream;
		err.message = `${stream} ${err.message}`;
		throw err;
	});
}

function makeError(result, options) {
	const stdout = result.stdout;
	const stderr = result.stderr;

	let err = result.error;
	const code = result.code;
	const signal = result.signal;

	const parsed = options.parsed;
	const joinedCmd = options.joinedCmd;
	const timedOut = options.timedOut || false;

	if (!err) {
		let output = '';

		if (Array.isArray(parsed.opts.stdio)) {
			if (parsed.opts.stdio[2] !== 'inherit') {
				output += output.length > 0 ? stderr : `\n${stderr}`;
			}

			if (parsed.opts.stdio[1] !== 'inherit') {
				output += `\n${stdout}`;
			}
		} else if (parsed.opts.stdio !== 'inherit') {
			output = `\n${stderr}${stdout}`;
		}

		err = new Error(`Command failed: ${joinedCmd}${output}`);
		err.code = code < 0 ? errname(code) : code;
	}

	err.stdout = stdout;
	err.stderr = stderr;
	err.failed = true;
	err.signal = signal || null;
	err.cmd = joinedCmd;
	err.timedOut = timedOut;

	return err;
}

function joinCmd(cmd, args) {
	let joinedCmd = cmd;

	if (Array.isArray(args) && args.length > 0) {
		joinedCmd += ' ' + args.join(' ');
	}

	return joinedCmd;
}

module.exports = (cmd, args, opts) => {
	// console.log('cmd: ', cmd); // cmd: 指令
	// console.log('args: ', args); // args: 傳入的參數
	// console.log('opts: ', opts); // opts: 傳入的options
	const parsed = handleArgs(cmd, args, opts);
	// console.log('handleArgs: ', parsed); // parsed: 回傳parsed後的obj
	const encoding = parsed.opts.encoding;
	const maxBuffer = parsed.opts.maxBuffer;
	const joinedCmd = joinCmd(cmd, args);
	// console.log('joinedCmd: ', joinedCmd); // 把cmd和args合併

	let spawned;
	try {
		spawned = childProcess.spawn(parsed.cmd, parsed.args, parsed.opts);
		// return 一個childprocess物件
		// console.log('spawned: ', spawned); // 開一個childProcess執行執行cmd
	} catch (err) {
		return Promise.reject(err);
	}

	let removeExitHandler;
	if (parsed.opts.cleanup) {
		// cleanup: Keep track of the spawned process and kill it when the parent process exits.
		// onExit: fire an event no matter how the process exits
		removeExitHandler = onExit(() => {
			spawned.kill();
		});
	}

	let timeoutId = null;
	let timedOut = false;

	const cleanupTimeout = () => {
		if (timeoutId) {
			clearTimeout(timeoutId); // Cancels a Timeout object created by setTimeout().
			timeoutId = null;
		}
	};

	// console.log(parsed.opts.timeout);
	if (parsed.opts.timeout > 0) {
		// 如果超過時限就把他砍掉
		timeoutId = setTimeout(() => {
			timeoutId = null;
			timedOut = true;
			spawned.kill(parsed.opts.killSignal);
		}, parsed.opts.timeout);
	}

	const processDone = new Promise(resolve => {
		spawned.on('exit', (code, signal) => {
			cleanupTimeout(); // 已經結束了, 所以把settimeout停掉
			resolve({code, signal});
		});

		spawned.on('error', err => {
			cleanupTimeout();
			resolve({error: err});
		});

		if (spawned.stdin) {
			spawned.stdin.on('error', err => {
				cleanupTimeout();
				resolve({error: err});
			});
		}
	});

	function destroy() {
		if (spawned.stdout) {
			spawned.stdout.destroy();
		}

		if (spawned.stderr) {
			spawned.stderr.destroy();
		}
	}

	const handlePromise = () => pFinally(Promise.all([
		processDone,
		getStream(spawned, 'stdout', encoding, maxBuffer),
		getStream(spawned, 'stderr', encoding, maxBuffer)
	]).then(arr => {
		const result = arr[0];
		result.stdout = arr[1];
		result.stderr = arr[2];

		if (removeExitHandler) {
			removeExitHandler();
		}

		if (result.error || result.code !== 0 || result.signal !== null) {
			const err = makeError(result, {
				joinedCmd,
				parsed,
				timedOut
			});

			// TODO: missing some timeout logic for killed
			// https://github.com/nodejs/node/blob/master/lib/child_process.js#L203
			// err.killed = spawned.killed || killed;
			err.killed = err.killed || spawned.killed;

			if (!parsed.opts.reject) {
				return err;
			}

			throw err;
		}

		return {
			stdout: handleOutput(parsed.opts, result.stdout),
			stderr: handleOutput(parsed.opts, result.stderr),
			code: 0,
			failed: false,
			killed: false,
			signal: null,
			cmd: joinedCmd,
			timedOut: false
		};
	}), destroy);

	crossSpawn._enoent.hookChildProcess(spawned, parsed.parsed);

	handleInput(spawned, parsed.opts);

	spawned.then = (onfulfilled, onrejected) => handlePromise().then(onfulfilled, onrejected); // execa(...).then時會call
	spawned.catch = onrejected => handlePromise().catch(onrejected); // execa(...).catch時會call
	
	return spawned;
};

module.exports.stdout = function () {
	// TODO: set `stderr: 'ignore'` when that option is implemented
	return module.exports.apply(null, arguments).then(x => x.stdout);
};

module.exports.stderr = function () {
	// TODO: set `stdout: 'ignore'` when that option is implemented
	return module.exports.apply(null, arguments).then(x => x.stderr);
};

module.exports.shell = (cmd, opts) => handleShell(module.exports, cmd, opts);

module.exports.sync = (cmd, args, opts) => {
	const parsed = handleArgs(cmd, args, opts);
	const joinedCmd = joinCmd(cmd, args);

	if (isStream(parsed.opts.input)) {
		throw new TypeError('The `input` option cannot be a stream in sync mode');
	}

	const result = childProcess.spawnSync(parsed.cmd, parsed.args, parsed.opts);
	result.code = result.status;

	if (result.error || result.status !== 0 || result.signal !== null) {
		const err = makeError(result, {
			joinedCmd,
			parsed
		});

		if (!parsed.opts.reject) {
			return err;
		}

		throw err;
	}

	return {
		stdout: handleOutput(parsed.opts, result.stdout),
		stderr: handleOutput(parsed.opts, result.stderr),
		code: 0,
		failed: false,
		signal: null,
		cmd: joinedCmd,
		timedOut: false
	};
};

module.exports.shellSync = (cmd, opts) => handleShell(module.exports.sync, cmd, opts);

module.exports.spawn = util.deprecate(module.exports, 'execa.spawn() is deprecated. Use execa() instead.');
