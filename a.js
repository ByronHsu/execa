const execa = require('./index.js');

execa('echo', ['unicorns']).then(result => {
   // console.log(result);
   // { stdout: 'unicorns',
   // stderr: '',
   // code: 0,
   // failed: false,
   // killed: false,
   // signal: null,
   // cmd: 'echo unicorns',
   // timedOut: false }
	console.log(result.stdout);
	//=> 'unicorns'
});

// // pipe the child process stdout to the current stdout
// execa('echo', ['unicorns']).stdout.pipe(process.stdout);

// execa.shell('echo unicorns').then(result => {
// 	console.log(result.stdout);
// 	//=> 'unicorns'
// });

// // example of catching an error
// execa.shell('exit 3').catch(error => {
// 	console.log(error);
// 	/*
// 	{
// 		message: 'Command failed: /bin/sh -c exit 3'
// 		killed: false,
// 		code: 3,
// 		signal: null,
// 		cmd: '/bin/sh -c exit 3',
// 		stdout: '',
// 		stderr: '',
// 		timedOut: false
// 	}
// 	*/
// });

// // example of catching an error with a sync method
// try {
// 	execa.shellSync('exit 3');
// } catch (err) {
// 	console.log(err);
// 	/*
// 	{
// 		message: 'Command failed: /bin/sh -c exit 3'
// 		code: 3,
// 		signal: null,
// 		cmd: '/bin/sh -c exit 3',
// 		stdout: '',
// 		stderr: '',
// 		timedOut: false
// 	}
// 	*/
// }