# Rotaz

**Any model in your Claude Code.** · [Leia em português](README.pt-BR.md)

Rotaz is a local gateway that lets Claude Code and Claude Desktop run on models from other providers: OpenAI, Gemini, DeepSeek, OpenRouter, local models and dozens more. It translates between the Anthropic and OpenAI APIs on your machine and comes with a web panel to manage providers, keys and models.

Created by **Alisson Paganini**.

## Download

Grab the file for your system from the [latest release](https://github.com/alissonpaganini/rotaz/releases/latest):

| System | File |
| --- | --- |
| Windows 10/11 | `Rotaz-<version>-Windows-x64-Setup.exe` |
| macOS (Apple Silicon and Intel) | `Rotaz-<version>-macOS-universal.dmg` |
| Ubuntu / Debian | `Rotaz-<version>-Linux-amd64.deb` |
| Other Linux (x64) | `Rotaz-<version>-Linux-x86_64.AppImage` |

The installers aren't code-signed yet, so your system asks for confirmation the first time:

- **Windows:** SmartScreen says "Windows protected your PC". Click **More info → Run anyway**.
- **macOS:** right-click the app → **Open**, or allow it in **System Settings → Privacy & Security**.
- **Linux:** install the `.deb` with `sudo apt install ./Rotaz-*.deb`. For the AppImage, run `chmod +x Rotaz-*.AppImage` (Ubuntu 22.04+ may need FUSE 2: `libfuse2t64`).

On Windows, the app updates itself. On macOS and Linux, it shows you the download link.

## Quick start

1. Open Rotaz and create the panel password.
2. **Add a provider:** sign in with an account (GitHub Copilot, ChatGPT, Kimi, Google Antigravity and others) or paste an API key. Import its models and test them in one go.
3. **Connect Claude:** the panel sets up Claude Desktop in one click. For Claude Code in the terminal, the **Claude Code** tab shows the address and token to copy:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "<gateway token>",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  }
}
```

Add this to `~/.claude/settings.json` (back the file up first).

### Run from source

Requires Node 20.11 or later. No dependencies to install.

```bash
npm start
```

The panel opens at <http://127.0.0.1:8787/>. On Windows, double-click `Iniciar.cmd`.

## Features

- **Translation both ways.** Claude Code speaks Anthropic Messages; most providers speak OpenAI Chat Completions. Rotaz also speaks Gemini (Google Antigravity) and the OpenAI Responses API.
- **Routing.** Each public alias (`claude-*`) points to a provider and a real model. Keys rotate automatically, and an optional fallback tries the next provider before any byte reaches the client.
- **Account sign-in.** Providers that work with a subscription connect through the account login, with no API key to copy.
- **Testing.** Real calls through the same path as live traffic: text, streaming and tool use.
- **Spending and budget.** Daily and monthly cost per provider, with limits that warn, block or switch to a cheaper model.
- **Profile backup.** Export providers, models and routes to a password-encrypted file and import it on another computer.
- **Eight languages:** English, Portuguese (Brazil), Spanish, Simplified Chinese, Japanese, Korean, German and French.

### Model names in Claude Desktop

Claude Code only lists models whose names contain `claude`, so aliases start with `claude-`. The Claude Desktop model picker also hides names that mention other vendors (`gpt`, `gemini`, `deepseek` and others). The panel tells you where each alias shows up and suggests names that work in both, like `claude-gpt-4o` → `claude-gept-4o`.

## Privacy and security

- Everything runs on your machine. Keys are encrypted at rest (AES-256-GCM) and never go back to the browser.
- The master key is protected by Windows DPAPI, the macOS Keychain or the Linux Secret Service.
- The panel only answers on this machine, with a strict CSP and CSRF and DNS rebinding protection. Outgoing calls are checked against SSRF.
- Your data lives in `%APPDATA%\Rotaz\data` (Windows), `~/Library/Application Support/Rotaz/data` (macOS) or `~/.config/Rotaz/data` (Linux). Updating or uninstalling doesn't touch it.
- The update check only sends your IP and the installed version, and you can turn it off in **Settings → System and security**.

## Building and releasing

```bash
cd desktop
npm install
npm run dist:win     # dist:mac on a Mac, dist:linux on Linux
```

To publish a version, bump `version` in `package.json` and `desktop/package.json`, add the version to [CHANGELOG.md](CHANGELOG.md), then push a tag (`git tag v1.2.0 && git push origin v1.2.0`). GitHub Actions builds every installer and publishes the release, with the release notes taken from the changelog.

## Credits

Rotaz was created by **Alisson Paganini**. If you use, fork or redistribute it, keep this credit and the copyright notice from the [license](LICENSE).

Bundled libraries and assets, all MIT or SIL OFL with their licenses alongside: Motion, Floating UI, Phosphor Icons, Hanken Grotesk, Geist Mono and provider logos from `@lobehub/icons`.

## License

[MIT](LICENSE) © 2026 Alisson Paganini
