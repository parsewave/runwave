const path = require('path');
const { ensureDir, safeName, writeJson } = require('./file-utils');

class OutputWriter {
  constructor(outputRoot) {
    this.outputRoot = outputRoot;
    ensureDir(outputRoot);
  }

  actionDir(actionName) {
    return ensureDir(path.join(this.outputRoot, safeName(actionName)));
  }

  response(actionName, payload) {
    const outputDir = this.actionDir(actionName);
    const responsePath = path.join(outputDir, 'response.json');
    const response = {
      ...payload,
      outputDir,
      responsePath,
    };
    writeJson(responsePath, response);
    return response;
  }

  artifactJson(actionName, fileName, payload) {
    const outputDir = this.actionDir(actionName);
    const file = path.join(outputDir, fileName);
    writeJson(file, payload);
    return file;
  }
}

module.exports = {
  OutputWriter,
};
