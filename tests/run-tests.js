"use strict";

const path = require("path");
const { createTestContext, TestReporter, runSuite } = require("./harness");

const suites = [
  { name: "01-utils-markdown", file: "./suites/01-utils-markdown" },
  { name: "02-mindmap-flowchart", file: "./suites/02-mindmap-flowchart" },
  { name: "03-llm-network", file: "./suites/03-llm-network" },
  { name: "04-translation-edge", file: "./suites/04-translation-edge" },
  { name: "05-layout-engine", file: "./suites/05-layout-engine" },
  { name: "06-chat-multimodal", file: "./suites/06-chat-multimodal" },
  { name: "07-mineru-storage", file: "./suites/07-mineru-storage" },
  { name: "08-ported-core", file: "./suites/08-ported-core" },
  { name: "09-contracts-ui", file: "./suites/09-contracts-ui" },
  { name: "10-agent-mcp", file: "./suites/10-agent-mcp" }
];

(async () => {
  const env = createTestContext();
  const reporter = new TestReporter();
  reporter.start();

  for (const s of suites) {
    const createSuite = require(s.file);
    const testMap = createSuite(env);
    await runSuite(s.name, testMap, env, reporter);
  }

  reporter.finish();
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
