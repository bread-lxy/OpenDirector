import { chooseGenerationModel } from "./model_picker.mjs";
/** Official provider configuration and first/last frame edits; no remote generation. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser } from "./engine.mjs";
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = {
  "X-OpenDirector-Request": "1",
  "Content-Type": "application/json",
};
async function call(path, body) {
  const response = await fetch(api + path, {
    headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
assert.equal((await call("/api/creation-test-health")).isolated, true);
const browser = await launchBrowser();
const page = await browser.newPage({ locale: "en-US", viewport: { width: 1600, height: 1100 } });
// Skip the first-run model setup welcome; it covers the canvas.
await page.addInitScript(() =>
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
);
await page.addInitScript(() => {
  document.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== "file") return;
    console.debug("H3 file selection", JSON.stringify({
      files: [...(input.files ?? [])].map((file) => ({ name: file.name, size: file.size, type: file.type })),
      workspaceBusy: document.querySelector('[data-testid="canvas-workspace"]')?.getAttribute("aria-busy"),
    }));
  }, true);
});
page.setDefaultTimeout(15000);
// Diagnostic branch only: retain the original upload sequence and deadlines.
// Buffer events in memory so recording does not add disk waits during imports.
const evidenceDir = join(process.env.RUNNER_TEMP ?? tmpdir(), "opendirector-h3");
mkdirSync(evidenceDir, { recursive: true });
const events = [];
const responses = [];
const started = performance.now();
let phase = "setup";
let projectId;
let lastSnapshot;
const record = (event) => {
  const entry = { ms: performance.now() - started, phase, ...event };
  events.push(entry);
  return entry;
};
page.on("pageerror", (error) => record({ pageError: error.stack }));
page.on("console", (message) => {
  if (message.type() === "error") record({ consoleError: message.text() });
  if (message.text().startsWith("H3 file selection ")) record({ fileSelection: message.text() });
});
page.on("requestfailed", (request) => record({
  requestFailed: request.url(), error: request.failure(),
}));
const isWrite = (request) =>
  request.url().includes("/api/creation/") && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method());
page.on("request", (request) => {
  if (!isWrite(request)) return;
  let body;
  if (request.headers()["content-type"]?.includes("application/json")) {
    body = request.postDataJSON();
  } else {
    const bytes = request.postDataBuffer();
    body = { available: bytes !== null, bytes: bytes?.length, sha256: bytes && createHash("sha256").update(bytes).digest("hex") };
  }
  record({ request: request.url(), method: request.method(), body });
});
page.on("response", (response) => {
  if (!isWrite(response.request())) return;
  const event = record({ response: response.url(), status: response.status() });
  responses.push(response.text().then((body) => { event.body = body; }, (error) => { event.error = String(error); }));
});
await page.context().tracing.start({ screenshots: true, snapshots: true });
try {
  // One official connection with both models, as the provider settings save
  // them; the picker step below switches between the two.
  const saved = await call("/api/model-configs/batch", {
    kind: "video",
    url: "https://fixture.invalid/v2",
    modelIds: ["MiniMax-H3", "MiniMax-H3-Lite"],
    apiKey: "fixture",
    protocol: "minimax_video_v2",
    connectionType: "api",
    authMode: "bearer",
  });
  const model = saved.find((item) => item.modelId === "MiniMax-H3");
  assert.deepEqual(model.inputRules.frameRoles, ["first_frame", "last_frame"]);
  projectId = crypto.randomUUID();
  await call(`/api/creation/projects/${projectId}/commands`, {
    commandId: crypto.randomUUID(),
    projectId,
    type: "project.create",
    payload: { name: `Official H3 ${projectId}` },
  });
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    canvas.getContext("2d").fillRect(0, 0, 256, 256);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  for (const name of ["first.png", "last.png"]) {
    phase = `upload ${name}`;
    record({ upload: name, bytes: Buffer.from(png, "base64").length });
    await page
      .getByLabel("Choose local asset files", { exact: true })
      .setInputFiles({
        name,
        mimeType: "image/png",
        buffer: Buffer.from(png, "base64"),
      });
    const count = name === "first.png" ? 1 : 2;
    for (let attempt = 0; attempt < 150; attempt++) {
      const current = await call(`/api/creation/projects/${projectId}`);
      lastSnapshot = current;
      if (attempt === 0 || attempt === 149 || current.canvasItems.length === count) {
        record({ poll: attempt, expectedCount: count, actualCount: current.canvasItems.length, snapshot: current });
      }
      if (current.canvasItems.length === count) break;
      if (attempt === 149) throw Error(`${name}: expected ${count} saved canvas items, received ${current.canvasItems.length}\n${await page.locator("body").innerText()}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const snapshot = await call(`/api/creation/projects/${projectId}`);
  assert.equal(snapshot.canvasItems.length, 2);
  phase = "frame configuration";
  const created = await page.evaluate(
    async ({ projectId, modelId, sources }) => {
      const { creationClient } = await import("/src/backend/creationClient.ts");
      const client = creationClient(projectId);
      await client.refresh();
      const specId = crypto.randomUUID(),
        itemId = crypto.randomUUID();
      const receipt = await client.command("canvas.createGeneration", {
        spec: {
          id: specId,
          projectId,
          kind: "video",
          purpose: "generation",
          modelConfigId: modelId,
          prompt: "Animate between these frames",
          parameters: {
            videoMode: "first_frame",
            resolution: "2K",
            durationSeconds: 5,
          },
        },
        item: {
          id: itemId,
          projectId,
          kind: "video",
          position: { x: 400, y: 50 },
          binding: { role: "generation", objectRef: { id: specId } },
        },
        references: sources.map((source, index) => ({
          id: crypto.randomUUID(),
          projectId,
          targetSpecId: specId,
          binding: "follow_current",
          source: { id: source.id },
          role: index ? "last_frame" : "first_frame",
          order: index,
        })),
      });
      if (receipt.status !== "applied") throw Error(JSON.stringify(receipt));
      return { itemId, specId };
    },
    { projectId, modelId: model.id, sources: snapshot.canvasItems },
  );
  await page.reload();
  const node = page.locator(`.react-flow__node[data-id="${created.itemId}"]`);
  await node.waitFor();
  await node.click();
  const first = page.getByLabel("Choose First frame", { exact: true });
  const last = page.getByLabel("Choose Last frame", { exact: true });
  await last.waitFor();
  await page.getByRole("combobox", { name: "Generation model", exact: true }).click();
  const models = page.getByRole("listbox", { name: "Generation model", exact: true });
  await models.getByRole("group", { name: "MiniMax official video", exact: true }).waitFor();
  assert.equal(await models.getByText("Local service", { exact: true }).count(), 0);
  await page.screenshot({ path: "/tmp/node-model-picker.png" });
  await page.keyboard.press("Escape");
  const lite = (await call("/api/model-configs")).find((item) => item.modelId === "MiniMax-H3-Lite");
  assert.ok(lite);
  await chooseGenerationModel(page, `config:${lite.id}`);
  await page.waitForFunction(async ({ projectId, specId, modelId }) => {
    const response = await fetch(`/api/creation/projects/${projectId}`, { headers: { "X-OpenDirector-Request": "1" } });
    const snapshot = await response.json();
    return snapshot.generationSpecs.find((spec) => spec.id === specId)?.modelConfigId === modelId;
  }, { projectId, specId: created.specId, modelId: lite.id });
  await chooseGenerationModel(page, `config:${model.id}`);

  assert.equal(await last.isEnabled(), true);
  assert.equal(await first.inputValue(), snapshot.canvasItems[0].id);
  assert.equal(await last.inputValue(), snapshot.canvasItems[1].id);
  await last.selectOption("");
  for (let attempt = 0; attempt < 150; attempt++) {
    const current = await call(`/api/creation/projects/${projectId}`);
    if (!current.references.some((ref) => ref.active && ref.targetSpecId === created.specId && ref.role === "last_frame")) break;
    if (attempt === 149) throw Error("tail frame edit was not committed");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await page.reload();
  await page.locator(`.react-flow__node[data-id="${created.itemId}"]`).click();
  assert.equal(
    await page.getByLabel("Choose Last frame", { exact: true }).inputValue(),
    "",
  );
  phase = "saved content verification";
  lastSnapshot = await call(`/api/creation/projects/${projectId}`);
  for (const source of snapshot.canvasItems) {
    const assetId = source.binding.objectRef.assetId;
    const response = await fetch(`${api}/api/creation/projects/${projectId}/assets/${assetId}/content`, { headers });
    assert.ok(response.ok);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, Buffer.from(png, "base64"));
    record({ savedSource: source.id, assetId, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  record({ finalSnapshot: lastSnapshot });
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "official provider config",
        "explicit frame roles",
        "frame projection after reload",
        "editable tail slot",
        "tail clearing persists",
      ],
    }),
  );
} catch (error) {
  record({ error: error.stack, url: page.url() });
  if (projectId) {
    try { lastSnapshot = await call(`/api/creation/projects/${projectId}`); }
    catch (failure) { record({ snapshotError: String(failure) }); }
  }
  try {
    writeFileSync(join(evidenceDir, "page.txt"), await page.locator("body").innerText());
    await page.screenshot({ path: join(evidenceDir, "failure.png"), fullPage: true });
  } catch (failure) { record({ pageCaptureError: String(failure) }); }
  throw error;
} finally {
  try {
    await Promise.all(responses);
    writeFileSync(join(evidenceDir, "events.json"), JSON.stringify(events, null, 2));
    if (lastSnapshot) writeFileSync(join(evidenceDir, "project.json"), JSON.stringify(lastSnapshot, null, 2));
    await page.context().tracing.stop({ path: join(evidenceDir, "trace.zip") });
    console.log(`H3 diagnostic evidence: ${evidenceDir}`);
  } finally {
    await browser.close();
  }
}
