#!/usr/bin/env node
import { ignoreClosedPipe, runCli } from '../lib/cli.js';

ignoreClosedPipe(process.stdout);
ignoreClosedPipe(process.stderr);
const exitCode = await runCli(process.argv.slice(2));
process.exitCode = exitCode;
