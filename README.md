# Local Whisper Transcriber

Record audio in Obsidian, transcribe it locally with `whisper.cpp`, and optionally generate a structured AI summary.

## Why this plugin exists

Most voice-note workflows are fragmented or cloud-only. This plugin is built for users who want:

- fast capture directly inside Obsidian
- local-first transcription on their own machine
- reliable meeting notes with minimal manual steps

It is designed to make spoken notes as easy as typed notes while keeping core transcription local.

## What it does

- Records microphone audio from inside Obsidian.
- Transcribes with local `whisper.cpp` (`ffmpeg` + `whisper-cli`).
- Shows clear live status:
  - red pulsing mic while recording
  - recording status indicator
  - conversion/transcription/summarization progress bars
- Inserts output into the current note, or creates a note when needed.
- Optionally summarizes transcripts via Azure OpenAI Responses API.
- Optionally auto-records Teams calls (macOS), opens a dedicated meeting note at start, and can auto-stop at call end.

## Requirements

- Obsidian desktop app (plugin is desktop-only).
- macOS.
- Local tools:
  - `brew install ffmpeg`
  - `brew install whisper-cpp`
- A local Whisper model file, for example:
  - `ggml-model-whisper-small.bin`

## Quick Start

1. Open plugin settings.
2. Click `Apply whisper.cpp preset`.
3. Update model path in the command template if needed.
4. Click `Check current command`.
5. Start recording and stop to transcribe.

## Default command template

```bash
ffmpeg -y -i {input} -ar 16000 -ac 1 {outputBase}.wav && whisper-cli -m '/path/to/ggml-model-whisper-small.bin' -f {outputBase}.wav -otxt -of {outputBase}
```

### Placeholders

- `{input}`: absolute path to recorded audio file
- `{outputDir}`: output directory
- `{outputBase}`: output path without extension
- `{outputTxt}`: expected transcript `.txt` path

## Teams Auto-Record (optional, macOS)

Enable `Auto-record when Teams call starts` to detect call windows and begin recording automatically.

- Creates and opens a new meeting note immediately when a call starts.
- Automatically starts recording when a call is detected.
- Automatically stops recording and transcribes when the call ends (if `Auto-stop when Teams call ends` is enabled).
- Meeting note title format:
  - `YYYY-MM-DD <Teams call title>`
- Supports:
  - `Auto-stop when Teams call ends`
  - configurable detection interval
  - configurable call keywords

If detection is blocked, grant Obsidian Accessibility access:
`System Settings -> Privacy & Security -> Accessibility`.

## OpenAI Summary (optional)

Enable `Summarize with OpenAI` and configure:

- `Azure OpenAI URL` (full Responses API URL, including `api-version`)
- `Azure API key` (Bearer token)
- `OpenAI model` (for example `gpt-5.1-codex-mini`)
- `Summary prompt`
- `Max output tokens`

The summary is inserted above the transcript, with specific insights called out.

## Privacy and data flow

- Audio recording and transcription run locally on your machine.
- Audio/transcript are sent to OpenAI only if `Summarize with OpenAI` is enabled.
- Teams detection reads Teams window titles on macOS for automation; no call audio is captured unless recording is started.

## Troubleshooting

- `command not found`:
  - install dependencies (`ffmpeg`, `whisper-cpp`)
  - use `Check current command` in settings
- No transcript output:
  - verify model path in command template
- Repeated macOS permission prompt for Teams:
  - allow Obsidian in Accessibility settings, then toggle Teams auto-record off/on

## Build

```bash
npm install
npm run build
```

## Manual install (development)

1. Copy to vault plugin folder:
   - `<vault>/.obsidian/plugins/local-whisper-transcriber/`
2. Ensure these files exist:
   - `manifest.json`
   - `main.js`
   - `styles.css`
3. Enable **Local Whisper Transcriber** in Obsidian Community Plugins.
