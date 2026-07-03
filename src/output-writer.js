const path = require('path');
const { ensureDir, safeName, writeJson } = require('./file-utils');

class OutputWriter {
  constructor(outputRoot, profiler = null) {
    this.outputRoot = outputRoot;
    this.profiler = profiler;
    this.timeSync('output.ensure_root', { outputRoot }, () => ensureDir(outputRoot));
  }

  timeSync(event, fields, fn) {
    if (this.profiler) return this.profiler.timeSync(event, fields, fn);
    if (typeof fields === 'function') return fields();
    return fn();
  }

  actionDir(actionName) {
    return this.timeSync('output.action_dir', { actionName }, () => ensureDir(path.join(this.outputRoot, safeName(actionName))));
  }

  response(actionName, payload) {
    return this.timeSync('output.response', { actionName }, () => {
      const outputDir = this.actionDir(actionName);
      const responsePath = path.join(outputDir, 'response.json');
      const response = {
        ...payload,
        outputDir,
        responsePath,
      };
      this.timeSync('output.response.write_json', { actionName, responsePath }, () => writeJson(responsePath, response));
      return response;
    });
  }

  artifactJson(actionName, fileName, payload) {
    return this.timeSync('output.artifact_json', { actionName, fileName }, () => {
      const outputDir = this.actionDir(actionName);
      const file = path.join(outputDir, fileName);
      this.timeSync('output.artifact_json.write_json', { actionName, file }, () => writeJson(file, payload));
      return file;
    });
  }
}

module.exports = {
  OutputWriter,
};
