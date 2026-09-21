<p align="center">
  <img src="./assets/logo.png" alt="Zylos" height="120">
</p>

<h1 align="center">zylos-imessage</h1>

<p align="center">
  iMessage communication channel for Zylos agents
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="Node.js"></a>
  <a href="https://discord.gg/GS2J39EGff"><img src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://x.com/ZylosAI"><img src="https://img.shields.io/badge/X-follow-000000?logo=x&logoColor=white" alt="X"></a>
  <a href="https://zylos.ai"><img src="https://img.shields.io/badge/website-zylos.ai-blue" alt="Website"></a>
  <a href="https://coco.xyz"><img src="https://img.shields.io/badge/Built%20by-Coco-orange" alt="Built by Coco"></a>
</p>

---

> [!IMPORTANT]
> This repository is an initial component scaffold. It does not yet connect to
> Apple's Messages app or provide working inbound or outbound iMessage delivery.

- **Zylos component lifecycle** — generated install, configure, and upgrade hooks
- **Persistent configuration** — component-owned data directory and hot reload scaffold
- **Communication interface** — outbound command shape ready for a future transport

## Install

```bash
zylos add imessage
```

Or manually:

```bash
cd ~/zylos/.claude/skills
git clone https://github.com/zylos-ai/zylos-imessage.git imessage
cd imessage && npm install
```

## Configuration

Edit `~/zylos/components/imessage/config.json`:

```json
{
  "enabled": true
}
```

## Usage

There is no operational usage yet. The transport, supported host platform,
permissions, endpoint identity, and C4 message flow still need to be designed
and implemented.

## Design Notes

Development-time architecture notes live in [docs/DESIGN.md](./docs/DESIGN.md).

## Built by Coco

Zylos is the open-source core of [Coco](https://coco.xyz/) — the AI employee platform.

## License

[MIT](./LICENSE)
