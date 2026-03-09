import { App, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, setIcon } from "obsidian";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

interface LocalWhisperSettings {
  whisperCommandTemplate: string;
  tempDir: string;
  insertMode: "cursor" | "append";
  prependTimestamp: boolean;
  recordingMimeType: string;
  fallbackFolder: string;
  keepTempFiles: boolean;
  summarizeWithOpenAI: boolean;
  azureOpenAIEndpoint: string;
  azureOpenAIModel: string;
  azureApiKey: string;
  summaryPrompt: string;
  includeOriginalTranscriptWhenSummarized: boolean;
  maxCompletionTokens: number;
  autoRecordOnTeamsCall: boolean;
  autoStopWhenTeamsCallEnds: boolean;
  teamsDetectionIntervalSeconds: number;
  teamsCallKeywords: string;
}

const DEFAULT_SETTINGS: LocalWhisperSettings = {
  whisperCommandTemplate:
    "ffmpeg -y -i {input} -ar 16000 -ac 1 {outputBase}.wav && whisper-cli -m '/path/to/ggml-model-whisper-small.bin' -f {outputBase}.wav -otxt -of {outputBase}",
  tempDir: path.join(os.tmpdir(), "obsidian-whisper"),
  insertMode: "append",
  prependTimestamp: true,
  recordingMimeType: "audio/webm",
  fallbackFolder: "Transcripts",
  keepTempFiles: false,
  summarizeWithOpenAI: false,
  azureOpenAIEndpoint: "",
  azureOpenAIModel: "gpt-5.1-codex-mini",
  azureApiKey: "",
  summaryPrompt: DEFAULT_SUMMARY_PROMPT,
  includeOriginalTranscriptWhenSummarized: true,
  maxCompletionTokens: 4096,
  autoRecordOnTeamsCall: false,
  autoStopWhenTeamsCallEnds: false,
  teamsDetectionIntervalSeconds: 6,
  teamsCallKeywords: "meeting, call, in call, live"
};

interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface TranscriptResult {
  transcript: string;
  audioPath: string;
  transcriptPath: string | null;
}

interface CommandCheckResult {
  ok: boolean;
  binaries: Array<{ name: string; location?: string; ok: boolean }>;
}

interface WorkflowProgressUi {
  notice: Notice;
  root: HTMLDivElement;
  detail: HTMLDivElement;
  conversionBar: HTMLProgressElement;
  conversionText: HTMLDivElement;
  transcriptionBar: HTMLProgressElement;
  transcriptionText: HTMLDivElement;
  summarizationBar: HTMLProgressElement;
  summarizationText: HTMLDivElement;
}

interface RecordingContext {
  isTeamsCall: boolean;
  teamsTitle: string | null;
  autoStarted: boolean;
  notePath: string | null;
}

const COMMON_MAC_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];
const LEGACY_SUMMARY_PROMPT =
  "Summarize the following meeting transcript into concise bullet points with: key decisions, action items (owner + due date if mentioned), risks/issues, and open questions.";
const DEFAULT_SUMMARY_PROMPT =
  "Create a high-signal summary of this transcript. Include: (1) concise overview, (2) key points discussed, (3) specific insights and notable observations worth calling out, (4) action items with owners/dates if present, (5) risks, blockers, or ambiguities. If details are uncertain, state uncertainty briefly instead of saying 'none' everywhere.";

export default class LocalWhisperTranscriberPlugin extends Plugin {
  settings!: LocalWhisperSettings;

  private recorder: MediaRecorder | null = null;
  private mediaStream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private toggleRibbonEl: HTMLElement | null = null;
  private statusBarEl: HTMLElement | null = null;
  private teamsPollTimer: number | null = null;
  private teamsPollInFlight = false;
  private teamsCallDetected = false;
  private autoStartedRecording = false;
  private teamsPermissionNoticeShown = false;
  private teamsAccessBlocked = false;
  private isProcessing = false;
  private latestTeamsCallTitle: string | null = null;
  private currentRecordingContext: RecordingContext | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addCommand({
      id: "start-audio-recording",
      name: "Start audio recording",
      callback: () => {
        void this.startRecording();
      }
    });

    this.addCommand({
      id: "stop-and-transcribe-audio",
      name: "Stop recording and transcribe into note",
      callback: () => {
        void this.stopAndTranscribe();
      }
    });

    this.toggleRibbonEl = this.addRibbonIcon("mic", "Start audio recording", () => {
      void this.toggleRecordingFromRibbon();
    });
    this.statusBarEl = this.addStatusBarItem();
    this.updateToggleRibbonButton();
    this.startTeamsMonitoring();

    this.addSettingTab(new LocalWhisperSettingTab(this.app, this));
  }

  onunload(): void {
    if (this.recorder?.state === "recording") {
      this.recorder.stop();
    }

    this.stopTeamsMonitoring();
    this.stopTracks();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    const currentPrompt = (this.settings.summaryPrompt ?? "").trim();
    if (!currentPrompt || currentPrompt === LEGACY_SUMMARY_PROMPT) {
      this.settings.summaryPrompt = DEFAULT_SUMMARY_PROMPT;
      await this.saveSettings();
    }
    this.settings.teamsDetectionIntervalSeconds = Math.max(2, this.settings.teamsDetectionIntervalSeconds || 6);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  refreshTeamsMonitoring(): void {
    this.teamsAccessBlocked = false;
    this.teamsPermissionNoticeShown = false;
    this.stopTeamsMonitoring();
    this.startTeamsMonitoring();
  }

  private async startRecording(options?: { autoStarted?: boolean; teamsTitle?: string | null }): Promise<void> {
    if (this.recorder?.state === "recording") {
      new Notice("Recording is already running.");
      this.updateToggleRibbonButton();
      return;
    }

    if (typeof MediaRecorder === "undefined") {
      new Notice("MediaRecorder is not available in this environment.");
      this.updateToggleRibbonButton();
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      new Notice("Audio recording is not available on this device.");
      this.updateToggleRibbonButton();
      return;
    }

    try {
      const currentTeamsTitle = options?.teamsTitle ?? (await this.getCurrentTeamsCallTitle());
      this.currentRecordingContext = {
        isTeamsCall: Boolean(currentTeamsTitle),
        teamsTitle: currentTeamsTitle ?? null,
        autoStarted: options?.autoStarted === true,
        notePath: null
      };

      if (this.currentRecordingContext.isTeamsCall) {
        await this.ensureTeamsCallNoteReady(this.currentRecordingContext);
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaStream = stream;
      this.chunks = [];

      const recorderOptions: MediaRecorderOptions = {};
      const requestedMime = this.settings.recordingMimeType.trim();
      if (requestedMime.length > 0 && MediaRecorder.isTypeSupported(requestedMime)) {
        recorderOptions.mimeType = requestedMime;
      }

      this.recorder = new MediaRecorder(stream, recorderOptions);
      this.recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.chunks.push(event.data);
        }
      };

      this.recorder.onstop = () => {
        this.stopTracks();
        this.updateToggleRibbonButton();
      };

      this.recorder.start();
      this.updateToggleRibbonButton();
      new Notice(this.currentRecordingContext.isTeamsCall ? "Recording started for Teams call." : "Recording started.");
    } catch (error) {
      this.stopTracks();
      this.recorder = null;
      this.currentRecordingContext = null;
      this.chunks = [];
      this.updateToggleRibbonButton();
      new Notice(`Unable to start recording: ${this.toMessage(error)}`);
    }
  }

  private async stopAndTranscribe(): Promise<void> {
    if (!this.recorder || this.recorder.state !== "recording") {
      new Notice("No recording in progress.");
      this.updateToggleRibbonButton();
      return;
    }

    this.isProcessing = true;
    let progressUi: WorkflowProgressUi | null = null;
    try {
      progressUi = this.createWorkflowProgressUi();
      const blob = await this.stopRecording();
      new Notice("Transcribing with local Whisper...");

      const result = await this.transcribeBlob(blob, progressUi);
      let summary: string | null = null;
      if (this.settings.summarizeWithOpenAI) {
        this.updateWorkflowProgressUi(progressUi, {
          detail: "Summarizing with OpenAI...",
          summarization: 10
        });
        summary = await this.summarizeTranscript(result.transcript, (value) => {
          this.updateWorkflowProgressUi(progressUi, {
            detail: "Summarizing with OpenAI...",
            summarization: value
          });
        });
        this.updateWorkflowProgressUi(progressUi, {
          detail: "Summary completed.",
          summarization: 100
        });
      } else {
        this.updateWorkflowProgressUi(progressUi, { summarization: 100 });
      }

      await this.insertTranscript(result.transcript, summary, this.currentRecordingContext);

      if (!this.settings.keepTempFiles) {
        await this.cleanupArtifacts(result.audioPath);
      }

      if (!this.settings.keepTempFiles && result.transcriptPath) {
        await fs.rm(result.transcriptPath, { force: true });
      }

      this.finishWorkflowProgressUi(progressUi, "Done");
      new Notice("Transcript inserted into note.");
    } catch (error) {
      if (progressUi) {
        this.updateWorkflowProgressUi(progressUi, { detail: "Failed" });
        window.setTimeout(() => progressUi?.notice.hide(), 1200);
      }
      new Notice(`Transcription failed: ${this.toMessage(error)}`);
    } finally {
      this.currentRecordingContext = null;
      this.isProcessing = false;
      this.updateToggleRibbonButton();
    }
  }

  private async toggleRecordingFromRibbon(): Promise<void> {
    if (this.recorder?.state === "recording") {
      await this.stopAndTranscribe();
      return;
    }

    await this.startRecording();
  }

  private updateToggleRibbonButton(): void {
    if (!this.toggleRibbonEl) {
      return;
    }

    const isRecording = this.recorder?.state === "recording";
    setIcon(this.toggleRibbonEl, "mic");
    this.toggleRibbonEl.setAttribute(
      "aria-label",
      isRecording ? "Stop recording and transcribe" : "Start audio recording"
    );
    this.toggleRibbonEl.setAttribute(
      "title",
      isRecording ? "Recording in progress - click to stop and transcribe" : "Start audio recording"
    );
    this.toggleRibbonEl.toggleClass("lwt-ribbon-recording", isRecording);
    this.updateStatusBar(isRecording ? "Recording in progress" : "Ready");
  }

  private stopRecording(): Promise<Blob> {
    const recorder = this.recorder;

    if (!recorder || recorder.state !== "recording") {
      return Promise.reject(new Error("No active recorder."));
    }

    return new Promise((resolve, reject) => {
      const onStop = () => {
        cleanup();
        const mimeType = recorder.mimeType || this.settings.recordingMimeType || "audio/webm";
        const blob = new Blob(this.chunks, { type: mimeType });
        this.chunks = [];
        this.recorder = null;
        resolve(blob);
      };

      const onError = () => {
        cleanup();
        this.chunks = [];
        this.recorder = null;
        reject(new Error("Recorder stopped due to an error."));
      };

      const cleanup = () => {
        recorder.removeEventListener("stop", onStop);
        recorder.removeEventListener("error", onError);
      };

      recorder.addEventListener("stop", onStop, { once: true });
      recorder.addEventListener("error", onError, { once: true });
      recorder.stop();
    });
  }

  private async transcribeBlob(blob: Blob, progressUi: WorkflowProgressUi): Promise<TranscriptResult> {
    const tempDir = await this.ensureTempDir();
    const stamp = this.timestampToken();
    const audioPath = path.join(tempDir, `recording-${stamp}.webm`);
    const outputDir = tempDir;
    const outputBase = path.join(outputDir, `recording-${stamp}`);
    const outputWav = `${outputBase}.wav`;
    const outputTxt = `${outputBase}.txt`;

    const buffer = Buffer.from(await blob.arrayBuffer());
    await fs.writeFile(audioPath, buffer);
    this.updateWorkflowProgressUi(progressUi, {
      detail: "Preparing files...",
      conversion: 5,
      transcription: 0
    });

    const modelPath = this.extractWhisperModelPath(this.settings.whisperCommandTemplate);
    let finalResult: ShellResult;

    if (modelPath) {
      const conversionCmd = `ffmpeg -y -i ${this.shellEscape(audioPath)} -ar 16000 -ac 1 ${this.shellEscape(outputWav)}`;
      const transcribeCmd = `whisper-cli -m ${this.shellEscape(modelPath)} -f ${this.shellEscape(
        outputWav
      )} -otxt -of ${this.shellEscape(outputBase)}`;

      this.updateWorkflowProgressUi(progressUi, {
        detail: "Converting audio...",
        conversion: 10,
        transcription: 0
      });

      const conversionResult = await this.runPhaseWithProgress(conversionCmd, 10, 92, (value) => {
        this.updateWorkflowProgressUi(progressUi, {
          detail: "Converting audio...",
          conversion: value
        });
      });
      if (conversionResult.code !== 0) {
        throw new Error(conversionResult.stderr.trim() || conversionResult.stdout.trim() || "Audio conversion failed.");
      }
      this.updateWorkflowProgressUi(progressUi, {
        detail: "Audio converted.",
        conversion: 100,
        transcription: 5
      });

      this.updateWorkflowProgressUi(progressUi, {
        detail: "Transcribing...",
        transcription: 10
      });
      finalResult = await this.runPhaseWithProgress(transcribeCmd, 10, 95, (value) => {
        this.updateWorkflowProgressUi(progressUi, {
          detail: "Transcribing...",
          transcription: value
        });
      });
      if (finalResult.code !== 0) {
        throw new Error(await this.buildTranscriptionError(finalResult));
      }
      this.updateWorkflowProgressUi(progressUi, {
        detail: "Transcription completed.",
        transcription: 100
      });
    } else {
      const command = this.renderCommand(this.settings.whisperCommandTemplate, {
        input: audioPath,
        outputDir,
        outputBase,
        outputTxt
      });
      this.updateWorkflowProgressUi(progressUi, {
        detail: "Running transcription command...",
        conversion: 100,
        transcription: 10
      });
      finalResult = await this.runPhaseWithProgress(command, 10, 95, (value) => {
        this.updateWorkflowProgressUi(progressUi, {
          detail: "Running transcription command...",
          transcription: value
        });
      });
      if (finalResult.code !== 0) {
        throw new Error(await this.buildTranscriptionError(finalResult));
      }
      this.updateWorkflowProgressUi(progressUi, {
        detail: "Transcription completed.",
        transcription: 100
      });
    }

    let transcriptPath: string | null = null;
    let transcript = "";

    try {
      transcript = (await fs.readFile(outputTxt, "utf8")).trim();
      transcriptPath = outputTxt;
    } catch {
      transcript = finalResult.stdout.trim();
    }

    if (!transcript) {
      throw new Error(
        "Whisper finished but no transcript text was found. Check your command template and placeholders."
      );
    }

    return {
      transcript,
      audioPath,
      transcriptPath
    };
  }

  private async insertTranscript(
    transcript: string,
    summary: string | null,
    context: RecordingContext | null
  ): Promise<void> {
    const block = this.buildTranscriptBlock(transcript, summary);

    if (context?.isTeamsCall) {
      const filePath = await this.ensureTeamsCallNoteReady(context);
      const existing = this.app.vault.getAbstractFileByPath(filePath);
      if (existing instanceof TFile) {
        const existingText = await this.app.vault.read(existing);
        const separator = existingText.trim().length > 0 ? "\n\n" : "";
        await this.app.vault.modify(existing, `${existingText}${separator}${block}`);
        await this.app.workspace.getLeaf(true).openFile(existing);
      }
      return;
    }

    const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);

    if (markdownView?.editor) {
      if (this.settings.insertMode === "cursor") {
        markdownView.editor.replaceSelection(block);
        return;
      }

      const lastLine = markdownView.editor.lastLine();
      const lastLineLength = markdownView.editor.getLine(lastLine).length;
      const currentText = markdownView.editor.getValue();
      const separator = currentText.length === 0 ? "" : currentText.endsWith("\n") ? "\n" : "\n\n";
      markdownView.editor.replaceRange(`${separator}${block}`, { line: lastLine, ch: lastLineLength });
      return;
    }

    const filePath = await this.nextTranscriptFilePath();
    await this.app.vault.create(filePath, block);
    new Notice(`Created ${filePath}`);
  }

  private buildTranscriptBlock(transcript: string, summary: string | null): string {
    const sections: string[] = [];
    const withTimestamp = this.settings.prependTimestamp;
    const now = new Date().toLocaleString();
    const stamp = withTimestamp ? ` (${now})` : "";

    if (summary) {
      sections.push(`## Summary${stamp}\n\n${summary.trim()}`);
    }

    if (!summary || this.settings.includeOriginalTranscriptWhenSummarized) {
      if (summary) {
        sections.push(`## Transcript${stamp}\n\n${transcript}`);
      } else if (withTimestamp) {
        sections.push(`## Transcript${stamp}\n\n${transcript}`);
      } else {
        sections.push(transcript);
      }
    }

    return `${sections.join("\n\n").trim()}\n`;
  }

  private renderCommand(template: string, variables: Record<string, string>): string {
    return template.replace(/\{(input|outputDir|outputBase|outputTxt)\}/g, (full, key) => {
      const value = variables[key];
      return value ? this.shellEscape(value) : full;
    });
  }

  private shellEscape(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  private runShell(command: string): Promise<ShellResult> {
    return new Promise((resolve, reject) => {
      const currentPath = process.env.PATH ?? "";
      const mergedPath = [...COMMON_MAC_BIN_DIRS, currentPath]
        .filter((entry, index, values) => entry.length > 0 && values.indexOf(entry) === index)
        .join(":");

      const child = spawn("/bin/zsh", ["-lc", command], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: mergedPath
        }
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code) => {
        resolve({
          code: code ?? 1,
          stdout,
          stderr
        });
      });
    });
  }

  private async buildTranscriptionError(result: ShellResult): Promise<string> {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    const raw = stderr || stdout || `Whisper exited with code ${result.code}`;
    const lowered = raw.toLowerCase();

    if (!lowered.includes("command not found")) {
      return raw;
    }

    const detectedModel = await this.detectWhisperModelPath();
    const modelHint = detectedModel ?? "/path/to/ggml-model-whisper-small.bin";
    const commandHint = `ffmpeg -y -i {input} -ar 16000 -ac 1 {outputBase}.wav && whisper-cli -m '${modelHint}' -f {outputBase}.wav -otxt -of {outputBase}`;

    return [
      raw,
      "Install whisper.cpp dependencies and update the plugin command template.",
      "Recommended macOS setup:",
      "1) brew install ffmpeg",
      "2) brew install whisper-cpp",
      `3) Set command template to: ${commandHint}`
    ].join("\n");
  }

  async detectWhisperModelPath(): Promise<string | null> {
    const candidateDirs = [
      path.join(os.homedir(), "Library/Application Support/whisper.cpp"),
      path.join(os.homedir(), ".cache/whisper"),
      path.join(os.homedir(), "models"),
      path.join(os.homedir(), "Downloads")
    ];

    for (const dir of candidateDirs) {
      try {
        const entries = await fs.readdir(dir);
        const match = entries
          .filter((name) => name.endsWith(".bin") || name.endsWith(".gguf"))
          .sort((a, b) => a.localeCompare(b))
          .at(0);

        if (match) {
          return path.join(dir, match);
        }
      } catch {
        // Ignore missing folders; try next known location.
      }
    }

    return null;
  }

  getWhisperCppTemplate(modelPath?: string): string {
    const pathHint = modelPath?.trim() || "/path/to/ggml-model-whisper-small.bin";
    return `ffmpeg -y -i {input} -ar 16000 -ac 1 {outputBase}.wav && whisper-cli -m ${this.shellEscape(
      pathHint
    )} -f {outputBase}.wav -otxt -of {outputBase}`;
  }

  private extractWhisperModelPath(template: string): string | null {
    const match = template.match(/\bwhisper-cli\b[\s\S]*?\s-m\s+('([^']+)'|"([^"]+)"|(\S+))/);
    const value = match?.[2] ?? match?.[3] ?? match?.[4];
    return value ? value.trim() : null;
  }

  private async runPhaseWithProgress(
    command: string,
    start: number,
    maxBeforeFinish: number,
    onProgress: (value: number) => void
  ): Promise<ShellResult> {
    let value = start;
    onProgress(value);

    const timer = window.setInterval(() => {
      value = Math.min(maxBeforeFinish, value + 2);
      onProgress(value);
    }, 180);

    try {
      return await this.runShell(command);
    } finally {
      window.clearInterval(timer);
    }
  }

  private async summarizeTranscript(transcript: string, onProgress: (value: number) => void): Promise<string> {
    const endpoint = this.settings.azureOpenAIEndpoint.trim();
    const key = this.settings.azureApiKey.trim();
    const model = this.settings.azureOpenAIModel.trim();

    if (!endpoint) {
      throw new Error("OpenAI summary is enabled, but Azure OpenAI URL is empty.");
    }
    if (!key) {
      throw new Error("OpenAI summary is enabled, but Azure API key is empty.");
    }
    if (!model) {
      throw new Error("OpenAI summary is enabled, but model is empty.");
    }

    let value = 10;
    onProgress(value);
    const timer = window.setInterval(() => {
      value = Math.min(92, value + 2);
      onProgress(value);
    }, 200);

    try {
      const summaryInstructions = this.buildSummaryInstructions(this.settings.summaryPrompt.trim());
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify({
          model,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `${summaryInstructions}\n\nTranscript:\n${transcript}`
                }
              ]
            }
          ],
          max_output_tokens: this.settings.maxCompletionTokens
        })
      });

      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errorMessage =
          json?.error?.message ?? json?.message ?? `OpenAI request failed with status ${response.status}`;
        throw new Error(errorMessage);
      }

      const summary = this.normalizeSummaryText(this.extractSummaryText(json));
      if (!summary) {
        throw new Error("OpenAI returned an empty summary.");
      }

      onProgress(100);
      return summary;
    } finally {
      window.clearInterval(timer);
    }
  }

  private extractSummaryText(payload: any): string {
    if (typeof payload?.output_text === "string" && payload.output_text.trim().length > 0) {
      return payload.output_text;
    }

    const outputItems = Array.isArray(payload?.output) ? payload.output : [];
    const chunks: string[] = [];
    for (const item of outputItems) {
      const contents = Array.isArray(item?.content) ? item.content : [];
      for (const content of contents) {
        if (typeof content?.text === "string") {
          chunks.push(content.text);
        }
      }
    }

    return chunks.join("\n").trim();
  }

  private buildSummaryInstructions(userPrompt: string): string {
    const base = userPrompt.length > 0 ? userPrompt : DEFAULT_SUMMARY_PROMPT;
    return [
      base,
      "Requirements:",
      "- Provide a substantive summary based on what was said.",
      "- Include a section titled 'Specific insights to call out' with multiple concrete bullets when content allows.",
      "- Avoid repetitive boilerplate like 'none identified' across all sections unless the transcript is truly empty.",
      "- If audio/transcript quality is poor, explicitly state what is uncertain and still summarize what is clear.",
      "- Keep output concise and scannable with headings and bullets."
    ].join("\n");
  }

  private normalizeSummaryText(value: string): string {
    const cleaned = value
      .replace(/\r\n/g, "\n")
      .replace(/^\s*-\s*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const genericPattern =
      /(none noted|none assigned|none identified|none raised|no .* identified|no .* noted)/gi;
    const genericMatches = cleaned.match(genericPattern) ?? [];
    if (genericMatches.length >= 3) {
      return `${cleaned}\n\nNote: Output looked generic. Re-run with a more specific prompt or verify transcript quality.`;
    }

    return cleaned;
  }

  async checkCommandTemplate(template: string): Promise<CommandCheckResult> {
    const binaries = this.extractCommandBinaries(template);
    if (binaries.length === 0) {
      return { ok: false, binaries: [] };
    }

    const checks: Array<{ name: string; location?: string; ok: boolean }> = [];
    for (const binary of binaries) {
      const result = await this.runShell(`command -v ${this.shellEscape(binary)}`);
      if (result.code === 0) {
        const location = result.stdout.trim().split("\n").find((line) => line.trim().length > 0);
        checks.push({ name: binary, location, ok: true });
      } else {
        checks.push({ name: binary, ok: false });
      }
    }

    return {
      ok: checks.every((entry) => entry.ok),
      binaries: checks
    };
  }

  private extractCommandBinaries(template: string): string[] {
    const trimmed = template.trim();
    if (!trimmed) {
      return [];
    }

    const separators = /&&|\|\||;|\n/g;
    const parts = trimmed
      .split(separators)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    const binaries: string[] = [];
    for (const part of parts) {
      const tokens = part.split(/\s+/);
      for (const token of tokens) {
        if (!token.includes("=")) {
          const binary = token.replace(/^['"]|['"]$/g, "");
          if (binary.length > 0 && !binaries.includes(binary)) {
            binaries.push(binary);
          }
          break;
        }
      }
    }

    return binaries;
  }

  private async ensureTempDir(): Promise<string> {
    const configured = this.settings.tempDir.trim();
    const dir = configured.length > 0 ? configured : DEFAULT_SETTINGS.tempDir;
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  private timestampToken(): string {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
      now.getHours()
    )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  private dateToken(): string {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  private async cleanupArtifacts(audioPath: string): Promise<void> {
    const dir = path.dirname(audioPath);
    const prefix = path.parse(audioPath).name;

    try {
      const entries = await fs.readdir(dir);
      await Promise.all(
        entries
          .filter((entry) => entry === `${prefix}.webm` || entry.startsWith(`${prefix}.`))
          .map((entry) => fs.rm(path.join(dir, entry), { force: true }))
      );
    } catch {
      // Ignore cleanup failures.
    }
  }

  private async nextTranscriptFilePath(): Promise<string> {
    const folderPath = this.settings.fallbackFolder.trim().replace(/^\/+|\/+$/g, "");
    if (folderPath.length > 0) {
      await this.ensureFolder(folderPath);
    }

    const baseName = `Transcript ${this.timestampToken()}`;
    const parent = folderPath.length > 0 ? `${folderPath}/` : "";

    let counter = 0;
    while (true) {
      const suffix = counter === 0 ? "" : ` ${counter}`;
      const candidate = `${parent}${baseName}${suffix}.md`;
      if (!this.app.vault.getAbstractFileByPath(candidate)) {
        return candidate;
      }
      counter += 1;
    }
  }

  private async nextTeamsCallFilePath(teamsTitle: string): Promise<string> {
    const folderPath = this.settings.fallbackFolder.trim().replace(/^\/+|\/+$/g, "");
    if (folderPath.length > 0) {
      await this.ensureFolder(folderPath);
    }

    const cleanTitle = this.sanitizeFileNamePart(teamsTitle) || "Teams Call";
    const baseName = `${this.dateToken()} ${cleanTitle}`;
    const parent = folderPath.length > 0 ? `${folderPath}/` : "";

    let counter = 0;
    while (true) {
      const suffix = counter === 0 ? "" : ` ${counter}`;
      const candidate = `${parent}${baseName}${suffix}.md`;
      if (!this.app.vault.getAbstractFileByPath(candidate)) {
        return candidate;
      }
      counter += 1;
    }
  }

  private async ensureTeamsCallNoteReady(context: RecordingContext): Promise<string> {
    if (context.notePath) {
      const existing = this.app.vault.getAbstractFileByPath(context.notePath);
      if (existing) {
        if (existing instanceof TFile) {
          await this.app.workspace.getLeaf(true).openFile(existing);
        }
        return context.notePath;
      }
    }

    const teamsTitle = context.teamsTitle ?? "Teams Call";
    const filePath = await this.nextTeamsCallFilePath(teamsTitle);
    const file = await this.app.vault.create(filePath, "");
    context.notePath = filePath;
    await this.app.workspace.getLeaf(true).openFile(file);
    new Notice(`Opened meeting note: ${filePath}`);
    return filePath;
  }

  private sanitizeFileNamePart(value: string): string {
    const cleaned = value.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
    if (cleaned.length <= 90) {
      return cleaned;
    }
    return `${cleaned.slice(0, 90).trim()}...`;
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    const segments = folderPath.split("/").filter(Boolean);
    let currentPath = "";

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(currentPath);
      if (!existing) {
        await this.app.vault.createFolder(currentPath);
      } else if (!(existing instanceof TFolder)) {
        throw new Error(`Path '${currentPath}' exists and is not a folder.`);
      }
    }
  }

  private stopTracks(): void {
    if (!this.mediaStream) {
      return;
    }

    for (const track of this.mediaStream.getTracks()) {
      track.stop();
    }

    this.mediaStream = null;
  }

  private toMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  formatError(error: unknown): string {
    return this.toMessage(error);
  }

  private createWorkflowProgressUi(): WorkflowProgressUi {
    const notice = new Notice("", 0);
    const root = createDiv({ cls: "lwt-progress" });
    const title = root.createDiv({ cls: "lwt-progress-title", text: "Transcription in progress" });
    title.setAttr("aria-live", "polite");
    const detail = root.createDiv({ cls: "lwt-progress-detail", text: "Starting..." });

    const conversionWrap = root.createDiv({ cls: "lwt-progress-row" });
    conversionWrap.createDiv({ cls: "lwt-progress-label", text: "Conversion" });
    const conversionBar = conversionWrap.createEl("progress", { cls: "lwt-progress-bar" });
    conversionBar.max = 100;
    conversionBar.value = 0;
    const conversionText = conversionWrap.createDiv({ cls: "lwt-progress-value", text: "0%" });

    const transcriptionWrap = root.createDiv({ cls: "lwt-progress-row" });
    transcriptionWrap.createDiv({ cls: "lwt-progress-label", text: "Transcription" });
    const transcriptionBar = transcriptionWrap.createEl("progress", { cls: "lwt-progress-bar" });
    transcriptionBar.max = 100;
    transcriptionBar.value = 0;
    const transcriptionText = transcriptionWrap.createDiv({ cls: "lwt-progress-value", text: "0%" });

    const summarizationWrap = root.createDiv({ cls: "lwt-progress-row" });
    summarizationWrap.createDiv({ cls: "lwt-progress-label", text: "Summarization" });
    const summarizationBar = summarizationWrap.createEl("progress", { cls: "lwt-progress-bar" });
    summarizationBar.max = 100;
    summarizationBar.value = this.settings.summarizeWithOpenAI ? 0 : 100;
    const summarizationText = summarizationWrap.createDiv({
      cls: "lwt-progress-value",
      text: this.settings.summarizeWithOpenAI ? "0%" : "N/A"
    });

    notice.noticeEl.empty();
    notice.noticeEl.appendChild(root);

    return {
      notice,
      root,
      detail,
      conversionBar,
      conversionText,
      transcriptionBar,
      transcriptionText,
      summarizationBar,
      summarizationText
    };
  }

  private updateWorkflowProgressUi(
    ui: WorkflowProgressUi,
    update: { detail?: string; conversion?: number; transcription?: number; summarization?: number }
  ): void {
    if (update.detail) {
      ui.detail.setText(update.detail);
    }
    if (typeof update.conversion === "number") {
      const value = Math.max(0, Math.min(100, Math.round(update.conversion)));
      ui.conversionBar.value = value;
      ui.conversionText.setText(`${value}%`);
    }
    if (typeof update.transcription === "number") {
      const value = Math.max(0, Math.min(100, Math.round(update.transcription)));
      ui.transcriptionBar.value = value;
      ui.transcriptionText.setText(`${value}%`);
    }
    if (typeof update.summarization === "number") {
      const value = Math.max(0, Math.min(100, Math.round(update.summarization)));
      ui.summarizationBar.value = value;
      ui.summarizationText.setText(`${value}%`);
    }
  }

  private finishWorkflowProgressUi(ui: WorkflowProgressUi, detail: string): void {
    this.updateWorkflowProgressUi(ui, {
      detail,
      conversion: 100,
      transcription: 100,
      summarization: 100
    });
    window.setTimeout(() => ui.notice.hide(), 700);
  }

  private updateStatusBar(text: string): void {
    if (!this.statusBarEl) {
      return;
    }
    const isRecording = this.recorder?.state === "recording";
    this.statusBarEl.setText(isRecording ? `● ${text}` : text);
    this.statusBarEl.toggleClass("lwt-status-recording", isRecording);
  }

  private startTeamsMonitoring(): void {
    if (!this.settings.autoRecordOnTeamsCall || this.teamsPollTimer !== null) {
      return;
    }

    const intervalMs = Math.max(2000, Math.round(this.settings.teamsDetectionIntervalSeconds * 1000));
    this.teamsPollTimer = window.setInterval(() => {
      void this.checkTeamsStateForAutoRecord();
    }, intervalMs);
    void this.checkTeamsStateForAutoRecord();
  }

  private stopTeamsMonitoring(): void {
    if (this.teamsPollTimer !== null) {
      window.clearInterval(this.teamsPollTimer);
      this.teamsPollTimer = null;
    }
    this.teamsPollInFlight = false;
    this.teamsCallDetected = false;
    this.autoStartedRecording = false;
  }

  private async checkTeamsStateForAutoRecord(): Promise<void> {
    if (this.teamsPollInFlight || this.isProcessing || this.teamsAccessBlocked) {
      return;
    }

    this.teamsPollInFlight = true;
    try {
      const titles = await this.getTeamsWindowTitles();
      const detectedTitle = this.detectTeamsCallTitle(titles);
      const active = Boolean(detectedTitle);
      this.latestTeamsCallTitle = detectedTitle;

      if (active && !this.teamsCallDetected) {
        this.teamsCallDetected = true;
        if (this.recorder?.state !== "recording") {
          await this.startRecording({ autoStarted: true, teamsTitle: detectedTitle });
          this.autoStartedRecording = this.recorder?.state === "recording";
          if (this.autoStartedRecording) {
            new Notice("Auto-started recording from Teams call detection.");
          }
        }
        return;
      }

      if (!active && this.teamsCallDetected) {
        this.teamsCallDetected = false;
        if (this.settings.autoStopWhenTeamsCallEnds && this.autoStartedRecording && this.recorder?.state === "recording") {
          new Notice("Teams call appears to have ended. Auto-stopping recording.");
          await this.stopAndTranscribe();
        }
        this.autoStartedRecording = false;
      }
    } finally {
      this.teamsPollInFlight = false;
    }
  }

  private async getTeamsWindowTitles(): Promise<string[]> {
    if (this.teamsAccessBlocked) {
      return [];
    }

    const script = [
      "osascript <<'APPLESCRIPT'",
      "tell application \"System Events\"",
      "  if exists process \"Microsoft Teams\" then",
      "    tell process \"Microsoft Teams\"",
      "      set windowNames to name of windows",
      "    end tell",
      "    set AppleScript's text item delimiters to linefeed",
      "    set outputText to windowNames as text",
      "    set AppleScript's text item delimiters to \"\"",
      "    return outputText",
      "  else",
      "    return \"\"",
      "  end if",
      "end tell",
      "APPLESCRIPT"
    ].join("\n");

    const result = await this.runShell(script);
    if (result.code !== 0) {
      this.teamsAccessBlocked = true;
      this.stopTeamsMonitoring();
      if (!this.teamsPermissionNoticeShown) {
        this.teamsPermissionNoticeShown = true;
        new Notice(
          "Teams auto-record paused. Grant Obsidian Accessibility permission (System Settings > Privacy & Security > Accessibility), then toggle Teams auto-record off/on."
        );
      }
      return [];
    }

    const raw = result.stdout.trim();
    if (!raw) {
      return [];
    }
    return raw
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  private detectTeamsCallTitle(windowTitles: string[]): string | null {
    if (windowTitles.length === 0) {
      return null;
    }
    const keywords = this.settings.teamsCallKeywords
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0);
    if (keywords.length === 0) {
      return null;
    }
    const ranked: Array<{ title: string; score: number }> = [];
    for (const title of windowTitles) {
      const lower = title.toLowerCase();
      if (keywords.some((keyword) => lower.includes(keyword))) {
        const cleaned = this.cleanTeamsWindowTitle(title);
        if (!cleaned) {
          continue;
        }
        let score = 0;
        if (lower.includes("meeting")) {
          score += 3;
        }
        if (lower.includes("call")) {
          score += 2;
        }
        if (cleaned.toLowerCase().includes("(no subject)")) {
          score += 4;
        }
        if (lower.includes("calendar")) {
          score -= 2;
        }
        if (cleaned.length > 64) {
          score -= 1;
        }
        ranked.push({ title: cleaned, score });
      }
    }
    if (ranked.length === 0) {
      return null;
    }
    ranked.sort((a, b) => b.score - a.score || a.title.length - b.title.length);
    return ranked[0].title;
  }

  private async getCurrentTeamsCallTitle(): Promise<string | null> {
    if (this.latestTeamsCallTitle) {
      return this.latestTeamsCallTitle;
    }
    const titles = await this.getTeamsWindowTitles();
    return this.detectTeamsCallTitle(titles);
  }

  private cleanTeamsWindowTitle(raw: string): string {
    let value = raw.trim();

    value = value
      .replace(/\b(microsoft teams meeting|microsoft teams)\b/gi, "")
      .replace(/\bcalendar\b/gi, "")
      .replace(/\b(join|chat)\b/gi, "")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "")
      .replace(/\s*\|\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    value = value
      .replace(/(microsoft teams\s*)+$/i, "")
      .replace(/(calendar\s*)+$/i, "")
      .trim();

    return value;
  }
}

class LocalWhisperSettingTab extends PluginSettingTab {
  plugin: LocalWhisperTranscriberPlugin;

  constructor(app: App, plugin: LocalWhisperTranscriberPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Local Whisper Transcriber" });

    containerEl.createEl("h3", { text: "Whisper.cpp setup" });
    containerEl.createEl("p", {
      text: "Use the preset, then run Check command to confirm your whisper.cpp tools are available."
    });

    const commandSetting = new Setting(containerEl)
      .setName("Whisper.cpp command template")
      .setDesc(
        "Shell command used for transcription. Supported placeholders: {input}, {outputDir}, {outputBase}, {outputTxt}."
      );

    let commandTextArea: HTMLTextAreaElement | null = null;
    commandSetting.addTextArea((text) => {
      commandTextArea = text.inputEl;
      text.setValue(this.plugin.settings.whisperCommandTemplate);
      text.inputEl.rows = 4;
      text.inputEl.cols = 80;
      text.onChange(async (value) => {
        this.plugin.settings.whisperCommandTemplate = value.trim();
        await this.plugin.saveSettings();
      });
    });

    new Setting(containerEl)
      .setName("Apply whisper.cpp preset")
      .setDesc("Uses ffmpeg to convert webm recording to wav, then runs whisper-cli.")
      .addButton((button) => {
        button.setButtonText("Apply");
        button.onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("Applying...");
          try {
            const modelPath = await this.plugin.detectWhisperModelPath();
            this.plugin.settings.whisperCommandTemplate = this.plugin.getWhisperCppTemplate(modelPath ?? undefined);
            await this.plugin.saveSettings();
            if (commandTextArea) {
              commandTextArea.value = this.plugin.settings.whisperCommandTemplate;
            }
            new Notice(
              modelPath
                ? "Applied whisper.cpp preset with detected model path."
                : "Applied whisper.cpp preset. Update model path if needed."
            );
          } catch (error) {
            new Notice(`Failed to apply preset: ${this.plugin.formatError(error)}`);
          } finally {
            button.setButtonText("Apply");
            button.setDisabled(false);
          }
        });
      })
      .addExtraButton((button) => {
        button.setIcon("search");
        button.setTooltip("Show detected model path");
        button.onClick(async () => {
          const modelPath = await this.plugin.detectWhisperModelPath();
          new Notice(modelPath ? `Detected model: ${modelPath}` : "No local whisper model found.");
        });
      });

    new Setting(containerEl)
      .setName("Check current command")
      .setDesc("Verifies that the configured command binary is available in Obsidian.")
      .addButton((button) => {
        button.setButtonText("Check");
        button.onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("Checking...");
          try {
            const check = await this.plugin.checkCommandTemplate(this.plugin.settings.whisperCommandTemplate);
            if (check.ok) {
              const locations = check.binaries
                .map((entry) => (entry.location ? `${entry.name} -> ${entry.location}` : entry.name))
                .join(", ");
              new Notice(`Command OK: ${locations}`);
            } else if (check.binaries.length === 0) {
              new Notice("Command check failed: template is empty.");
            } else {
              const missing = check.binaries
                .filter((entry) => !entry.ok)
                .map((entry) => entry.name)
                .join(", ");
              new Notice(`Command not found: ${missing}. Install missing commands and re-check.`);
            }
          } catch (error) {
            new Notice(`Command check failed: ${this.plugin.formatError(error)}`);
          } finally {
            button.setButtonText("Check");
            button.setDisabled(false);
          }
        });
      });

    containerEl.createEl("h3", { text: "Install commands" });
    containerEl.createEl("p", {
      text: "Run these in Terminal, then return here and press Check."
    });
    containerEl.createEl("pre", {
      text: [
        "brew install ffmpeg",
        "brew install whisper-cpp"
      ].join("\n")
    });

    containerEl.createEl("h3", { text: "OpenAI summary (optional)" });

    new Setting(containerEl)
      .setName("Summarize with OpenAI")
      .setDesc("Generate a summary after transcription using Azure OpenAI Responses API.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.summarizeWithOpenAI).onChange(async (value) => {
          this.plugin.settings.summarizeWithOpenAI = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Azure OpenAI URL")
      .setDesc("Full Responses API URL, including api-version.")
      .addText((text) => {
        text.setPlaceholder("https://.../openai/responses?api-version=...")
          .setValue(this.plugin.settings.azureOpenAIEndpoint)
          .onChange(async (value) => {
            this.plugin.settings.azureOpenAIEndpoint = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = "100%";
      });

    new Setting(containerEl)
      .setName("Azure API key")
      .setDesc("Stored in plugin settings and used as Bearer token.")
      .addText((text) => {
        text.setPlaceholder("Paste key")
          .setValue(this.plugin.settings.azureApiKey)
          .onChange(async (value) => {
            this.plugin.settings.azureApiKey = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("OpenAI model")
      .setDesc("Model name sent in the request body.")
      .addText((text) => {
        text.setPlaceholder("gpt-5.1-codex-mini")
          .setValue(this.plugin.settings.azureOpenAIModel)
          .onChange(async (value) => {
            this.plugin.settings.azureOpenAIModel = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Summary prompt")
      .setDesc("Instruction used when summarizing the transcript.")
      .addTextArea((text) => {
        text.setValue(this.plugin.settings.summaryPrompt);
        text.inputEl.rows = 4;
        text.inputEl.cols = 80;
        text.onChange(async (value) => {
          this.plugin.settings.summaryPrompt = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Max output tokens")
      .setDesc("Upper output-token limit sent to the Responses API.")
      .addText((text) => {
        text.setValue(String(this.plugin.settings.maxCompletionTokens)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.maxCompletionTokens = Number.isFinite(parsed) && parsed > 0 ? parsed : 4096;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Keep transcript with summary")
      .setDesc("If enabled, insert both summary and full transcript.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.includeOriginalTranscriptWhenSummarized).onChange(async (value) => {
          this.plugin.settings.includeOriginalTranscriptWhenSummarized = value;
          await this.plugin.saveSettings();
        });
      });

    containerEl.createEl("h3", { text: "Teams auto-record (optional)" });

    new Setting(containerEl)
      .setName("Auto-record when Teams call starts")
      .setDesc("Detects likely Teams calls and starts recording automatically.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.autoRecordOnTeamsCall).onChange(async (value) => {
          this.plugin.settings.autoRecordOnTeamsCall = value;
          await this.plugin.saveSettings();
          this.plugin.refreshTeamsMonitoring();
        });
      });

    new Setting(containerEl)
      .setName("Auto-stop when Teams call ends")
      .setDesc("Only applies when recording was auto-started by Teams detection.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.autoStopWhenTeamsCallEnds).onChange(async (value) => {
          this.plugin.settings.autoStopWhenTeamsCallEnds = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Teams detection interval (seconds)")
      .setDesc("How often to check Teams window titles.")
      .addText((text) => {
        text.setValue(String(this.plugin.settings.teamsDetectionIntervalSeconds)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.teamsDetectionIntervalSeconds = Number.isFinite(parsed) && parsed >= 2 ? parsed : 6;
          await this.plugin.saveSettings();
          this.plugin.refreshTeamsMonitoring();
        });
      });

    new Setting(containerEl)
      .setName("Teams call keywords")
      .setDesc("Comma-separated keywords matched against Teams window titles.")
      .addText((text) => {
        text
          .setValue(this.plugin.settings.teamsCallKeywords)
          .onChange(async (value) => {
            this.plugin.settings.teamsCallKeywords = value.trim() || "meeting, call, in call, live";
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = "100%";
      });

    containerEl.createEl("h3", { text: "Advanced settings" });

    new Setting(containerEl)
      .setName("Temporary directory")
      .setDesc("Directory used for recorded audio and Whisper outputs.")
      .addText((text) => {
        text.setPlaceholder(DEFAULT_SETTINGS.tempDir)
          .setValue(this.plugin.settings.tempDir)
          .onChange(async (value) => {
            this.plugin.settings.tempDir = value.trim() || DEFAULT_SETTINGS.tempDir;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Recording MIME type")
      .setDesc("Preferred MIME type passed to MediaRecorder (for example audio/webm).")
      .addText((text) => {
        text.setValue(this.plugin.settings.recordingMimeType).onChange(async (value) => {
          this.plugin.settings.recordingMimeType = value.trim() || DEFAULT_SETTINGS.recordingMimeType;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Insert mode")
      .setDesc("Insert transcript at cursor or append to the current note.")
      .addDropdown((dropdown) => {
        dropdown.addOption("append", "Append at end");
        dropdown.addOption("cursor", "Insert at cursor");
        dropdown.setValue(this.plugin.settings.insertMode);
        dropdown.onChange(async (value) => {
          this.plugin.settings.insertMode = value === "cursor" ? "cursor" : "append";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Add timestamp heading")
      .setDesc("Prepend a heading with the current date/time before transcript text.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.prependTimestamp).onChange(async (value) => {
          this.plugin.settings.prependTimestamp = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Fallback folder")
      .setDesc("Used only when no markdown note is open. Example: Transcripts")
      .addText((text) => {
        text.setValue(this.plugin.settings.fallbackFolder).onChange(async (value) => {
          this.plugin.settings.fallbackFolder = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Keep temporary files")
      .setDesc("Keep recorded audio and Whisper output files in the temp directory.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.keepTempFiles).onChange(async (value) => {
          this.plugin.settings.keepTempFiles = value;
          await this.plugin.saveSettings();
        });
      });
  }
}
