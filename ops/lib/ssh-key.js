#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function defaultSshKey(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const existsSync = options.existsSync || fs.existsSync;

  if (env.RUNWAVE_SSH_KEY) return env.RUNWAVE_SSH_KEY;
  if (env.SSH_KEY) return env.SSH_KEY;

  const sshDir = path.join(homeDir, '.ssh');
  for (const name of ['id_ed25519', 'id_rsa']) {
    const candidate = path.join(sshDir, name);
    if (existsSync(candidate)) return candidate;
  }
  return path.join(sshDir, 'id_ed25519');
}

if (require.main === module) {
  process.stdout.write(`${defaultSshKey()}\n`);
}

module.exports = {
  defaultSshKey,
};
