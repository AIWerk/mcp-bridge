#!/usr/bin/env node
/**
 * Refuse to run the test suite on a Node major that cannot run it.
 *
 * tests/integration.test.ts and tests/oauth2-device-code.test.ts resolve
 * their fixtures through `import.meta.dirname`, which exists only from Node
 * 20.11. On Node 18 it is `undefined`, so `join(undefined, "..")` throws
 * ERR_INVALID_ARG_TYPE and those two tests fail for reasons that have
 * nothing to do with the code under test.
 *
 * That misreads as a broken repo. On 2026-07-30 it did exactly that twice
 * in one day: two people independently reported "2 pre-existing failures on
 * main" from a Node 18 shell, while the same commit was green on Node 22 and
 * in CI. Fail loudly and name the cause instead.
 *
 * This is a development requirement only, and deliberately does not narrow
 * the existing `engines: >=20.0.0`: src/ never touches import.meta.dirname,
 * so published consumers stay free to run any Node 20 or newer.
 */

const MIN_MAJOR = 20;
const RECOMMENDED = 22;
const actualMajor = Number(process.versions.node.split(".")[0]);

if (actualMajor < MIN_MAJOR) {
  console.error("");
  console.error(`  Node ${process.versions.node} is too old to run this test suite.`);
  console.error(`  (${process.execPath})`);
  console.error("");
  console.error(`  Two tests resolve fixtures via import.meta.dirname, which needs Node`);
  console.error(`  ${MIN_MAJOR}.11+. On older majors it is undefined and they fail with`);
  console.error(`  ERR_INVALID_ARG_TYPE — an environment problem wearing a test failure's`);
  console.error(`  clothes. This repo standardizes on Node ${RECOMMENDED}.`);
  console.error("");
  console.error(`  Fix:  nvm use ${RECOMMENDED}`);
  console.error("");
  process.exit(1);
}
