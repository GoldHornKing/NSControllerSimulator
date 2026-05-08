(function () {
  "use strict";

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const el = (id) => document.getElementById(id);

  const portSelect = el("ct-port");
  const openBtn = el("ct-open");
  const closeBtn = el("ct-close");
  const infoBtn = el("ct-info");
  const resetBtn = el("ct-reset");
  const refreshPortsBtn = el("ct-refresh-ports");
  const pairLrBtn = el("ct-pair-lr");
  const comboCommandsEl = el("ct-combo-commands");
  const comboLineNumbersEl = el("ct-combo-line-numbers");
  const executeComboBtn = el("ct-execute-combo");
  const nextColorBtn = el("ct-next-color");
  const terminateComboBtn = el("ct-terminate-combo");
  const clearComboBtn = el("ct-clear-combo");
  const splitByColorBtn = el("ct-split-by-color");
  const colorSplitDialog = el("ct-color-split-dialog");
  const colorSplitCloseBtn = el("ct-color-split-close");
  const colorSplitSummaryEl = el("ct-color-split-summary");
  const colorSplitSelectEl = el("ct-color-split-select");
  const colorSplitPreviewEl = el("ct-color-split-preview");
  const colorSplitIncludeSetupEl = el("ct-color-split-include-setup");
  const colorSplitLoadBtn = el("ct-color-split-load");
  const runModeHintEl = el("ct-run-mode-hint");
  const clearLogBtn = el("ct-clear-log");
  const logEl = el("ct-log");
  const connDot = el("ct-conn-dot");
  const connLabel = el("ct-conn-label");
  const commandButtons = () => Array.from(document.querySelectorAll("[data-ctrl]"));
  const POST_OPEN_STABILIZATION_MS = 3000;
  const OPEN_WARMUP_COMMANDS = ["E"];
  const OPEN_WARMUP_ACK_TIMEOUT_MS = 10000;
  const COMBO_BATCH_SIZE = 500;
  const DEFAULT_LOG_TEXT = "Simulator ready...";
  const MAX_RENDERED_LOG_LINES = 5000;

  // ── State ─────────────────────────────────────────────────────────────────
  let connectionOpen = false;
  let busy = false;
  let comboRunning = false;
  let comboTerminateRequested = false;
  let renderedLogLines = [];
  let pendingLogLines = [];
  let logFlushScheduled = false;
  let colorSplitState = null;
  let colorStepSession = null;

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function scrollLogToBottom() {
    logEl.scrollTop = logEl.scrollHeight;
    requestAnimationFrame(() => {
      logEl.scrollTop = logEl.scrollHeight;
    });
    setTimeout(() => {
      logEl.scrollTop = logEl.scrollHeight;
    }, 0);
  }

  // ── Log helpers ───────────────────────────────────────────────────────────
  function renderLog() {
    logEl.textContent = renderedLogLines.length > 0 ? `${renderedLogLines.join("\n")}\n` : "";
    scrollLogToBottom();
  }

  function flushPendingLogLines() {
    logFlushScheduled = false;

    if (pendingLogLines.length === 0) {
      return;
    }

    renderedLogLines.push(...pendingLogLines);
    pendingLogLines = [];

    if (renderedLogLines.length > MAX_RENDERED_LOG_LINES) {
      renderedLogLines = renderedLogLines.slice(-MAX_RENDERED_LOG_LINES);
    }

    renderLog();
  }

  function scheduleLogFlush() {
    if (logFlushScheduled) {
      return;
    }

    logFlushScheduled = true;
    requestAnimationFrame(flushPendingLogLines);
  }

  function appendLog(text) {
    pendingLogLines.push(text);
    scheduleLogFlush();
  }

  function clearLog() {
    renderedLogLines = [DEFAULT_LOG_TEXT];
    pendingLogLines = [];
    logFlushScheduled = false;
    renderLog();
  }

  function initializeLog() {
    renderedLogLines = [DEFAULT_LOG_TEXT];
    pendingLogLines = [];
    logFlushScheduled = false;
    renderLog();
  }

  function flushLogNow() {
    if (pendingLogLines.length === 0) {
      return;
    }

    flushPendingLogLines();
  }

  function appendLogLines(lines, prefix = "") {
    if (!Array.isArray(lines) || lines.length === 0) {
      return;
    }

    pendingLogLines.push(...lines.map((line) => prefix + line));
    scheduleLogFlush();
    flushLogNow();
  }

  function filterDeviceLinesForDisplay(lines) {
    return (lines ?? []).filter((line) => {
      // if (line === "INFO completed") {
      //   return true;
      // }

      // if (line.startsWith("INFO ")) {
      //   return false;
      // }

      if (line.startsWith("WARN ") || line.startsWith("WARNING ")) {
        return false;
      }

      return true;
    });
  }

  // ── Connection indicator ──────────────────────────────────────────────────
  function updateConnectionIndicator() {
    if (connectionOpen) {
      connDot.style.background = "#3aa17c";
      connLabel.textContent = "Session Open: " + (portSelect.value || "Unknown port");
    } else {
      connDot.style.background = "#aaa";
      connLabel.textContent = "Session Closed";
    }
  }

  function setBusy(value) {
    busy = value;
    syncControls();
  }

  function readComboCommands() {
    return comboCommandsEl.value
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function isColorSelectionCommand(command) {
    return /^C\s+\d+$/u.test(command);
  }

  function buildComboBatches(commands) {
    const logicalBlocks = [];
    let currentBlock = [];
    let currentStartLine = 1;

    commands.forEach((command, index) => {
      const lineNumber = index + 1;
      const startsColorBlock = isColorSelectionCommand(command);

      if (currentBlock.length === 0) {
        currentStartLine = lineNumber;
        currentBlock.push(command);
        return;
      }

      const currentBlockIsColorBlock = isColorSelectionCommand(currentBlock[0]);

      if (startsColorBlock || (!currentBlockIsColorBlock && isColorSelectionCommand(command))) {
        logicalBlocks.push({
          commands: currentBlock,
          startLine: currentStartLine,
          kind: currentBlockIsColorBlock ? "color" : "setup",
        });
        currentBlock = [command];
        currentStartLine = lineNumber;
        return;
      }

      currentBlock.push(command);
    });

    if (currentBlock.length > 0) {
      logicalBlocks.push({
        commands: currentBlock,
        startLine: currentStartLine,
        kind: isColorSelectionCommand(currentBlock[0]) ? "color" : "setup",
      });
    }

    return logicalBlocks.flatMap((block) => {
      const batches = [];

      for (let offset = 0; offset < block.commands.length; offset += COMBO_BATCH_SIZE) {
        const batchCommands = block.commands.slice(offset, offset + COMBO_BATCH_SIZE);
        const startLine = block.startLine + offset;
        const endLine = startLine + batchCommands.length - 1;
        batches.push({
          commands: batchCommands,
          startLine,
          endLine,
          kind: block.kind,
        });
      }

      return batches;
    });
  }

  function parseColorSlot(command) {
    const match = /^C\s+(\d+)$/u.exec(command);
    if (!match || match[1] === undefined) {
      return null;
    }

    return Number.parseInt(match[1], 10);
  }

  function splitCommandChainByColor(commands) {
    const setupCommands = [];
    const colorSegments = [];
    let activeColorSegment = null;

    commands.forEach((command, index) => {
      const lineNumber = index + 1;

      if (isColorSelectionCommand(command)) {
        if (activeColorSegment) {
          colorSegments.push(activeColorSegment);
        }

        activeColorSegment = {
          type: "color",
          colorSlot: parseColorSlot(command),
          startLine: lineNumber,
          endLine: lineNumber,
          commands: [command],
        };
        return;
      }

      if (activeColorSegment) {
        activeColorSegment.commands.push(command);
        activeColorSegment.endLine = lineNumber;
        return;
      }

      setupCommands.push(command);
    });

    if (activeColorSegment) {
      colorSegments.push(activeColorSegment);
    }

    return {
      setupSegment:
        setupCommands.length > 0
          ? {
              type: "setup",
              startLine: 1,
              endLine: setupCommands.length,
              commands: setupCommands,
            }
          : null,
      colorSegments,
    };
  }

  function getSelectedColorSplitSegment() {
    if (!colorSplitState || !colorSplitSelectEl || !colorSplitSelectEl.value) {
      return null;
    }

    const key = colorSplitSelectEl.value;

    if (key === "setup") {
      return colorSplitState.setupSegment;
    }

    if (!key.startsWith("color:")) {
      return null;
    }

    const index = Number.parseInt(key.slice(6), 10);
    if (!Number.isInteger(index) || index < 0 || index >= colorSplitState.colorSegments.length) {
      return null;
    }

    return colorSplitState.colorSegments[index];
  }

  function renderColorSplitPreview() {
    if (!colorSplitPreviewEl || !colorSplitSummaryEl || !colorSplitIncludeSetupEl) {
      return;
    }

    const selectedSegment = getSelectedColorSplitSegment();

    if (!selectedSegment) {
      colorSplitSummaryEl.textContent = "No segment selected.";
      colorSplitPreviewEl.value = "";
      colorSplitIncludeSetupEl.disabled = true;
      return;
    }

    const setupSegment = colorSplitState?.setupSegment;
    const includeSetup =
      selectedSegment.type === "color" &&
      Boolean(setupSegment) &&
      colorSplitIncludeSetupEl.checked;

    const previewCommands = includeSetup
      ? [
          ...setupSegment.commands,
          `# ── Color C ${selectedSegment.colorSlot ?? "?"} ─────────────────────────────────`,
          ...selectedSegment.commands,
        ]
      : selectedSegment.commands;

    const baseSummary =
      selectedSegment.type === "setup"
        ? `Setup block lines [${selectedSegment.startLine}-${selectedSegment.endLine}] · ${selectedSegment.commands.length} command(s)`
        : `Color block C ${selectedSegment.colorSlot ?? "?"} lines [${selectedSegment.startLine}-${selectedSegment.endLine}] · ${selectedSegment.commands.length} command(s)`;

    const setupSummary = includeSetup
      ? ` + setup ${setupSegment.commands.length} command(s) prepended`
      : "";

    colorSplitSummaryEl.textContent = baseSummary + setupSummary;
    colorSplitPreviewEl.value = previewCommands.join("\n");
    colorSplitIncludeSetupEl.disabled = !(selectedSegment.type === "color" && setupSegment);
  }

  function openColorSplitDialog() {
    const commands =
      colorStepSession && Array.isArray(colorStepSession.rawCommands)
        ? [...colorStepSession.rawCommands]
        : readComboCommands();

    if (commands.length === 0) {
      appendLog("[Error] Please enter command chain content first.");
      return;
    }

    const splitResult = splitCommandChainByColor(commands);

    if (!colorSplitSelectEl || !colorSplitDialog || !colorSplitIncludeSetupEl) {
      appendLog("[Error] Split dialog is unavailable.");
      return;
    }

    colorSplitState = splitResult;
    colorSplitSelectEl.innerHTML = "";

    if (splitResult.setupSegment) {
      const option = document.createElement("option");
      option.value = "setup";
      option.textContent = `Setup lines [${splitResult.setupSegment.startLine}-${splitResult.setupSegment.endLine}] (${splitResult.setupSegment.commands.length})`;
      colorSplitSelectEl.appendChild(option);
    }

    splitResult.colorSegments.forEach((segment, index) => {
      const option = document.createElement("option");
      option.value = `color:${index}`;
      option.textContent = `Color C ${segment.colorSlot ?? "?"} lines [${segment.startLine}-${segment.endLine}] (${segment.commands.length})`;
      colorSplitSelectEl.appendChild(option);
    });

    if (colorSplitSelectEl.options.length === 0) {
      appendLog("[Warn] No setup or color segments found.");
      return;
    }

    if (splitResult.colorSegments.length === 0) {
      appendLog("[Warn] No color commands found. You can still load setup commands.");
    }

    if (!colorStepSession || !Array.isArray(colorStepSession.rawCommands)) {
      colorStepSession = {
        setupSegment: splitResult.setupSegment,
        colorSegments: splitResult.colorSegments,
        includeSetup: true,
        nextColorIndex: 0,
        rawCommands: commands,
      };
    }

    colorSplitSelectEl.selectedIndex = 0;
    colorSplitIncludeSetupEl.checked = true;
    renderColorSplitPreview();

    if (typeof colorSplitDialog.showModal === "function") {
      colorSplitDialog.showModal();
    } else {
      colorSplitDialog.setAttribute("open", "open");
    }
  }

  function loadSelectedSplitIntoEditor() {
    if (!colorSplitState || !colorSplitIncludeSetupEl) {
      return;
    }

    const selectedSegment = getSelectedColorSplitSegment();

    if (!selectedSegment) {
      appendLog("[Error] Select a segment first.");
      return;
    }

    const setupSegment = colorSplitState.setupSegment;
    const selectedKey = colorSplitSelectEl?.value ?? "";
    const selectedColorIndex = selectedKey.startsWith("color:")
      ? Number.parseInt(selectedKey.slice(6), 10)
      : null;
    const includeSetup =
      selectedSegment.type === "color" &&
      Boolean(setupSegment) &&
      colorSplitIncludeSetupEl.checked;

    const nextCommands = includeSetup
      ? [...setupSegment.commands, ...selectedSegment.commands]
      : selectedSegment.commands;

    comboCommandsEl.value = nextCommands.join("\n");
    updateComboLineNumbers();
    if (selectedSegment.type === "color" && Number.isInteger(selectedColorIndex)) {
      colorStepSession = {
        setupSegment,
        colorSegments: colorSplitState.colorSegments,
        includeSetup,
        nextColorIndex: selectedColorIndex + 1,
        rawCommands: colorStepSession?.rawCommands ?? readComboCommands(),
      };
    } else if (selectedSegment.type === "setup") {
      colorStepSession = {
        setupSegment,
        colorSegments: colorSplitState.colorSegments,
        includeSetup: true,
        nextColorIndex: 0,
        rawCommands: colorStepSession?.rawCommands ?? readComboCommands(),
      };
    } else {
      colorStepSession = null;
    }

    syncControls();

    if (selectedSegment.type === "setup") {
      appendLog(`Loaded setup segment: ${selectedSegment.commands.length} command(s).`);
    } else {
      appendLog(
        `Loaded color C ${selectedSegment.colorSlot ?? "?"} segment: ${nextCommands.length} command(s).`
      );

      if (colorStepSession && colorStepSession.nextColorIndex < colorStepSession.colorSegments.length) {
        const upcoming = colorStepSession.colorSegments[colorStepSession.nextColorIndex];
        appendLog(`Next Color ready: C ${upcoming?.colorSlot ?? "?"}. Click Next Color to load it.`);
      } else {
        appendLog("Reached final color segment.");
      }
    }

    if (typeof colorSplitDialog.close === "function") {
      colorSplitDialog.close();
    } else {
      colorSplitDialog.removeAttribute("open");
    }
  }

  function loadNextColorSegment() {
    if (!colorStepSession || !Array.isArray(colorStepSession.colorSegments)) {
      appendLog("[Warn] No color step session active. Use Split by Color first.");
      return;
    }

    if (colorStepSession.nextColorIndex >= colorStepSession.colorSegments.length) {
      appendLog("[Warn] No more color segments remaining.");
      syncControls();
      return;
    }

    const segment = colorStepSession.colorSegments[colorStepSession.nextColorIndex];
    if (!segment) {
      appendLog("[Error] Failed to load next color segment.");
      return;
    }

    const commands = colorStepSession.includeSetup && colorStepSession.setupSegment
      ? [...colorStepSession.setupSegment.commands, ...segment.commands]
      : segment.commands;

    comboCommandsEl.value = commands.join("\n");
    updateComboLineNumbers();

    colorStepSession.nextColorIndex += 1;
    syncControls();

    appendLog(`Loaded next color C ${segment.colorSlot ?? "?"}: ${commands.length} command(s).`);

    if (colorStepSession.nextColorIndex < colorStepSession.colorSegments.length) {
      const upcoming = colorStepSession.colorSegments[colorStepSession.nextColorIndex];
      appendLog(`Upcoming color: C ${upcoming?.colorSlot ?? "?"}.`);
    } else {
      appendLog("No remaining colors. You reached the final segment.");
    }
  }

  function updateComboLineNumbers() {
    if (!comboLineNumbersEl) {
      return;
    }

    const lineCount = Math.max(1, comboCommandsEl.value.split(/\r?\n/u).length);
    comboLineNumbersEl.textContent = Array.from({ length: lineCount }, (_, i) => String(i + 1)).join("\n");
    comboLineNumbersEl.scrollTop = comboCommandsEl.scrollTop;
  }

  function updateRunModeHint() {
    if (!portSelect.value) {
      runModeHintEl.textContent = "Run Mode: Select a serial port to determine Dry Run vs Real Run.";
      runModeHintEl.className = "combo-run-mode-hint mode-muted";
      return;
    }

    const readyLabel = el("ct-health-ready")?.textContent?.trim();
    const readyForReports = readyLabel === "Yes";

    if (readyForReports) {
      runModeHintEl.textContent =
        "Run Mode: Real Run (Switch connected via bluetooth).";
      runModeHintEl.className = "combo-run-mode-hint mode-real";
      return;
    }

    runModeHintEl.textContent =
      "Run Mode: Dry Run (host-device only without bluetooth connection to the Switch).";
    runModeHintEl.className = "combo-run-mode-hint mode-dry";
  }

  function syncControls() {
    const hasPort = Boolean(portSelect.value);
    const canOperateController = connectionOpen && !busy;
    const showConnectFirstHint = !connectionOpen && !busy;
    const controlledButtons = [infoBtn, resetBtn, pairLrBtn, ...commandButtons()];

    portSelect.disabled = busy;
    refreshPortsBtn.disabled = busy;

    openBtn.disabled = busy || connectionOpen || !hasPort;
    closeBtn.disabled = busy || !connectionOpen;

    infoBtn.disabled = !canOperateController;
    resetBtn.disabled = !canOperateController;
    pairLrBtn.disabled = !canOperateController;

    commandButtons().forEach((btn) => {
      btn.disabled = !canOperateController;
    });

    controlledButtons.forEach((btn) => {
      if (!btn) {
        return;
      }

      if (showConnectFirstHint) {
        btn.title = "Connect first";
      } else {
        btn.removeAttribute("title");
      }
    });

    // Keep log clearing available regardless of connection state.
    clearLogBtn.disabled = false;

    const hasComboCommands = readComboCommands().length > 0;
    const canOperateCombo = connectionOpen && !busy;
    splitByColorBtn.disabled = busy || comboRunning || !hasComboCommands;
    nextColorBtn.disabled =
      busy ||
      comboRunning ||
      !colorStepSession ||
      colorStepSession.nextColorIndex >= colorStepSession.colorSegments.length;
    executeComboBtn.disabled = !canOperateCombo || comboRunning || !hasPort || !hasComboCommands;
    terminateComboBtn.disabled = !connectionOpen || !comboRunning;

    updateRunModeHint();
  }

  // ── Port loading ──────────────────────────────────────────────────────────
  async function loadPorts() {
    try {
      const res = await fetch("/api/ports");
      const data = await res.json();
      const ports = Array.isArray(data.ports) ? data.ports : [];

      portSelect.innerHTML = "";

      if (ports.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "No serial ports detected";
        portSelect.appendChild(opt);
        syncControls();
        return;
      }

      ports.forEach((port, i) => {
        const opt = document.createElement("option");
        opt.value = port.path;
        opt.textContent = port.label || port.path;
        // Prefer USB/ESP32 ports
        if (/usb|slab|espressif|cp210|wch|uart/i.test(opt.textContent) && i !== 0) {
          opt.selected = true;
        }
        portSelect.appendChild(opt);
      });
      syncControls();
    } catch (e) {
      appendLog("[Error] Failed to load serial ports: " + e.message);
      syncControls();
    }
  }

  // ── Open / Close connection ───────────────────────────────────────────────
  async function openConnection() {
    const portPath = portSelect.value;
    if (!portPath) {
      appendLog("[Error] Please select a serial port first.");
      return;
    }

    appendLog("Opening controller session: " + portPath);
    setBusy(true);

    try {
      const res = await fetch("/api/controller/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ portPath, baudRate: 115200 }),
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "Failed to open session");

      connectionOpen = true;
      appendLog("Controller session opened.");
      appendLog(`Stabilizing connection for ${POST_OPEN_STABILIZATION_MS}ms...`);
      await delay(POST_OPEN_STABILIZATION_MS);
      appendLog(`Running warm-up command: ${OPEN_WARMUP_COMMANDS.join(", ")}...`);

      try {
        const warmupResponse = await fetch("/api/controller/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commands: OPEN_WARMUP_COMMANDS,
            ackTimeoutMs: OPEN_WARMUP_ACK_TIMEOUT_MS,
          }),
        });
        const warmupPayload = await warmupResponse.json();

        if (!warmupResponse.ok) {
          throw new Error(warmupPayload.error || "Warm-up command failed");
        }

        appendLog("Warm-up completed.");
        appendLogLines(warmupPayload.lines, "[warmup] ");
      } catch (warmupError) {
        appendLog(`[Warn] Warm-up failed: ${warmupError.message}`);
      }

      appendLog("Session is ready for simulator commands.");
    } catch (e) {
      appendLog("[Error] Failed to open session: " + e.message);
    } finally {
      setBusy(false);
      updateConnectionIndicator();
      syncControls();
    }
  }

  async function closeConnection() {
    appendLog("Closing controller session...");
    setBusy(true);

    try {
      const res = await fetch("/api/controller/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "Failed to close session");

      connectionOpen = false;
      appendLog("Controller session closed.");
    } catch (e) {
      appendLog("[Error] Failed to close session: " + e.message);
    } finally {
      setBusy(false);
      updateConnectionIndicator();
      syncControls();
    }
  }

  // ── Send commands ─────────────────────────────────────────────────────────
  async function sendCommands(commands, label, options = {}) {
    if (!connectionOpen) {
      appendLog("[Error] Please open the serial connection first.");
      return;
    }

    appendLog((label ? label + ": " : "") + commands.join(", "));
    setBusy(true);

    try {
      const payload = {
        commands,
      };

      if (Number.isFinite(options.ackTimeoutMs) && options.ackTimeoutMs > 0) {
        payload.ackTimeoutMs = options.ackTimeoutMs;
      }

      if (Number.isFinite(options.retries) && options.retries >= 0) {
        payload.retries = options.retries;
      }

      const res = await fetch("/api/controller/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "Command execution failed");

      appendLog((label || "Done") + ": " + data.totalCommands + " command(s), target " + data.target);
      appendLogLines(filterDeviceLinesForDisplay(data.lines), "[device] ");

      if (data.lines) {
        updateStatusFromLines(data.lines);
      }
    } catch (e) {
      appendLog("[Error] " + e.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendCommandsInCombo(commands, options = {}) {
    if (!connectionOpen) {
      throw new Error("Please open the serial connection first.");
    }

    const payload = {
      commands,
    };

    if (Number.isFinite(options.ackTimeoutMs) && options.ackTimeoutMs > 0) {
      payload.ackTimeoutMs = options.ackTimeoutMs;
    }

    if (Number.isFinite(options.retries) && options.retries >= 0) {
      payload.retries = options.retries;
    }

    if (Number.isInteger(options.startLine) && options.startLine > 0) {
      payload.startLine = options.startLine;
    }

    if (Number.isInteger(options.endLine) && options.endLine >= payload.startLine) {
      payload.endLine = options.endLine;
    }

    const res = await fetch("/api/controller/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Command execution failed");
    }

    if (Number.isInteger(data.startLine) && Number.isInteger(data.endLine)) {
      appendLog(
        `Batch response: lines [${data.startLine}-${data.endLine}] ${data.totalCommands} command(s), target ${data.target}`
      );
    }

    appendLogLines(filterDeviceLinesForDisplay(data.lines), "[device] ");

    if (data.lines) {
      updateStatusFromLines(data.lines);
    }
  }

  async function executeComboCommands() {
    if (comboRunning) {
      appendLog("[Warn] Combo execution is already running.");
      return;
    }

    const commands = readComboCommands();
    if (commands.length === 0) {
      appendLog("[Error] Please enter at least one combo command.");
      return;
    }

    if (!portSelect.value) {
      appendLog("[Error] Please select a serial port first.");
      return;
    }

    if (!connectionOpen) {
      appendLog("[Error] Please open the connection first. Combo execution follows master connection controls.");
      return;
    }

    const TERMINATE_SIGNAL = "__ct_combo_terminated__";
    const throwIfTerminateRequested = () => {
      if (comboTerminateRequested) {
        throw new Error(TERMINATE_SIGNAL);
      }
    };

    comboRunning = true;
    comboTerminateRequested = false;
    setBusy(true);

    appendLog(`Starting combo execution: ${commands.length} command(s) -> ${portSelect.value}`);

    try {
      appendLog("Using active connection from Connection Controls.");

      throwIfTerminateRequested();

      appendLog("Querying status (I)...");
      await sendCommandsInCombo(["I"], { ackTimeoutMs: 10000, retries: 1 });
      throwIfTerminateRequested();

      appendLog("Session check passed (host-device only). Starting combo commands.");

      const commandBatches = buildComboBatches(commands);

      for (const batch of commandBatches) {
        throwIfTerminateRequested();

        const batchLabel = batch.kind === "color" ? "color batch" : "setup batch";
        appendLog(
          `Executing ${batchLabel} lines [${batch.startLine}-${batch.endLine}/${commands.length}] ${batch.commands.length} command(s)`
        );
        await sendCommandsInCombo(batch.commands, {
          ackTimeoutMs: 5000,
          retries: 1,
          startLine: batch.startLine,
          endLine: batch.endLine,
        });
      }

      appendLog(`Combo execution completed: ${commands.length} command(s).`);
    } catch (error) {
      if ((error instanceof Error ? error.message : String(error)) === TERMINATE_SIGNAL) {
        appendLog("Combo execution terminated by user.");
      } else {
        appendLog("[Error] Combo execution failed: " + (error instanceof Error ? error.message : String(error)));
      }
    } finally {
      comboRunning = false;
      comboTerminateRequested = false;
      setBusy(false);
      syncControls();
    }
  }

  // ── Status parsing ────────────────────────────────────────────────────────
  function readInfoLineMap(lines) {
    const info = {};
    (lines ?? []).forEach((line) => {
      const match = /^INFO\s+([^=]+)=(.*)$/u.exec(line);
      if (!match) return;
      const [, key, value] = match;
      info[key.trim()] = value.trim();
    });
    return info;
  }

  function boolFromInfo(value) {
    if (value === "true") return true;
    if (value === "false") return false;
    return null;
  }

  /** Show boolean as Yes/No; null/undefined -> Unknown */
  function boolLabel(value, trueLabel, falseLabel) {
    if (value === true) return trueLabel ?? "Yes";
    if (value === false) return falseLabel ?? "No";
    return "Unknown";
  }

  function updateStatusFromLines(lines) {
    const info = readInfoLineMap(lines);

    if (!info.transport && !info.bt_mode && !info.bt_profile) return;

    const discoverable = boolFromInfo(info.bt_discoverable);
    const authComplete = boolFromInfo(info.bt_auth_complete);
    const connected = boolFromInfo(info.bt_connected);
    const paired = boolFromInfo(info.bt_paired);
    const ready = boolFromInfo(info.bt_ready_for_reports);
    const initError = info.bt_init_error ?? "-";

    // Health indicators
    el("ct-health-discoverable").textContent = boolLabel(discoverable, "Yes", "No");
    el("ct-health-auth").textContent = boolLabel(authComplete, "Yes", "No");
    el("ct-health-connected").textContent = boolLabel(connected, "Yes", "No");
    el("ct-health-paired").textContent = boolLabel(paired, "Yes", "No");
    el("ct-health-ready").textContent = boolLabel(ready, "Yes", "No");

    // Meta rows
    el("ct-status-transport").textContent = info.transport ?? "-";
    el("ct-status-profile").textContent = info.bt_profile ?? info.bt_mode ?? "-";
    el("ct-status-peer").textContent = info.bt_last_peer ?? "-";
    el("ct-status-init-step").textContent = info.bt_init_step ?? "-";
    el("ct-status-init-error").textContent = initError;
    el("ct-status-time").textContent = new Date().toLocaleTimeString();

    // Status card tone + text
    let tone = "idle";
    let pill = "Idle";
    let title = "Waiting for Controller Session";
    let detail = "No usable controller session status has been received yet.";

    if (initError !== "-" && initError !== "ESP_OK") {
      tone = "error";
      pill = "Error";
      title = "Initialization Error";
      detail = "Bluetooth initialization stopped at " + (info.bt_init_step ?? "unknown") + " with " + initError + ".";
    } else if (ready === true) {
      tone = "success";
      pill = "Ready";
      title = "Controller Connected";
      detail = "The board is connected and ready to send button/stick reports.";
    } else if (connected === true) {
      tone = "running";
      pill = "Connected";
      title = "Connection Established";
      detail = "HID connection is established; waiting for pairing or report channel readiness.";
    } else if (authComplete === true) {
      tone = "running";
      pill = "Authenticated";
      title = "Authentication Complete";
      detail = "Switch authentication completed; attempting to finalize controller connection.";
    } else if (discoverable === true) {
      tone = "running";
      pill = "Broadcasting";
      title = "Waiting for Switch Discovery";
      detail = "The board is discoverable. Keep Switch on the 'Change Grip/Order' screen and wait.";
    }

    const card = el("ct-status-card");
    card.className = "firmware-status-card firmware-status-" + tone;
    card.style.cssText = "border: none; background: transparent; box-shadow: none; padding: 0; margin: 0;";

    el("ct-status-pill").textContent = pill;
    el("ct-status-title").textContent = title;
    el("ct-status-detail").textContent = detail;

    // Auto-expand status section when we get real data
    el("ct-status-details").open = true;
    updateRunModeHint();
  }

  // ── Event listeners ───────────────────────────────────────────────────────
  openBtn.addEventListener("click", openConnection);
  closeBtn.addEventListener("click", closeConnection);
  infoBtn.addEventListener("click", () => sendCommands(["I"], "Query Status", { ackTimeoutMs: 10000 }));
  resetBtn.addEventListener("click", () => sendCommands(["BT RESET"], "Reset Bluetooth"));
  pairLrBtn.addEventListener("click", () =>
    sendCommands(["BTN L+R"], "L+R Pairing", { ackTimeoutMs: 15000, retries: 2 })
  );
  clearLogBtn.addEventListener("click", clearLog);
  clearComboBtn.addEventListener("click", () => {
    comboCommandsEl.value = "";
    colorStepSession = null;
    colorSplitState = null;
    updateComboLineNumbers();
    syncControls();
  });
  splitByColorBtn.addEventListener("click", openColorSplitDialog);
  colorSplitCloseBtn.addEventListener("click", () => {
    if (typeof colorSplitDialog.close === "function") {
      colorSplitDialog.close();
    } else {
      colorSplitDialog.removeAttribute("open");
    }
  });
  colorSplitSelectEl.addEventListener("change", renderColorSplitPreview);
  colorSplitSelectEl.addEventListener("click", renderColorSplitPreview);
  colorSplitIncludeSetupEl.addEventListener("change", renderColorSplitPreview);
  colorSplitLoadBtn.addEventListener("click", loadSelectedSplitIntoEditor);
  nextColorBtn.addEventListener("click", loadNextColorSegment);
  executeComboBtn.addEventListener("click", () => {
    void executeComboCommands();
  });
  terminateComboBtn.addEventListener("click", () => {
    if (!comboRunning || comboTerminateRequested) {
      return;
    }

    comboTerminateRequested = true;
    appendLog("Terminate requested. Execution will stop after current command.");
    syncControls();
  });
  comboCommandsEl.addEventListener("input", () => {
    colorStepSession = null;
    colorSplitState = null;
    updateComboLineNumbers();
    syncControls();
  });
  comboCommandsEl.addEventListener("scroll", updateComboLineNumbers);
  refreshPortsBtn.addEventListener("click", () => loadPorts().then(() => appendLog("Serial port list refreshed.")));
  portSelect.addEventListener("change", syncControls);

  // Controller overlay buttons
  document.querySelectorAll("[data-ctrl]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cmd = btn.dataset.ctrl;
      sendCommands([cmd], cmd);
    });
  });

  // ── Init ──────────────────────────────────────────────────────────────────
  loadPorts();
  updateConnectionIndicator();
  initializeLog();
  updateComboLineNumbers();
  syncControls();
  updateRunModeHint();

  // Sync connection state on load
  fetch("/api/controller/status")
    .then((r) => r.json())
    .then((data) => {
      connectionOpen = Boolean(data.connection?.open);
      if (connectionOpen && data.connection?.portPath) {
        // Try to pre-select the active port
        for (const opt of portSelect.options) {
          if (opt.value === data.connection.portPath) {
            opt.selected = true;
            break;
          }
        }
      }
      updateConnectionIndicator();
      syncControls();
    })
    .catch(() => {
      syncControls();
    });
})();
