'use strict';

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function appendJsonl(file, payload) {
  fs.appendFileSync(file, `${JSON.stringify(payload)}\n`);
}

class AgentRecorder {
  constructor(outputDir) {
    this.outputDir = ensureDir(outputDir);
    this.sequencesPath = path.join(this.outputDir, 'agent-sequences.jsonl');
    this.actionsPath = this.sequencesPath;
    this.observationsPath = path.join(this.outputDir, 'agent-observations.jsonl');
    this.promptsPath = path.join(this.outputDir, 'agent-prompts.jsonl');
    this.summaryPath = path.join(this.outputDir, 'agent-summary.json');
  }

  observation(payload) {
    appendJsonl(this.observationsPath, { ts: new Date().toISOString(), ...payload });
  }

  sequence(payload) {
    appendJsonl(this.sequencesPath, { ts: new Date().toISOString(), ...payload });
  }

  action(payload) {
    this.sequence(payload);
  }

  prompt(payload) {
    appendJsonl(this.promptsPath, { ts: new Date().toISOString(), ...payload });
  }

  summary(payload) {
    fs.writeFileSync(this.summaryPath, `${JSON.stringify(payload, null, 2)}\n`);
  }
}

module.exports = {
  AgentRecorder,
};
