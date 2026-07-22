module.exports = require('../src/repeated-frame-remover');

if (require.main === module) {
  const { main } = module.exports;
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
