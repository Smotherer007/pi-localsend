# pi-localsend

LocalSend extension for the [pi coding agent](https://github.com/earendil-works/pi).

Send and receive files between pi and any device running [LocalSend](https://github.com/localsend/localsend) — phone, tablet, or another computer — directly over the local network. No account, no cloud, nothing leaves the LAN.

Implements the [LocalSend protocol v2.1](https://github.com/localsend/protocol) natively, with no runtime dependency beyond `typebox`.

## Installation

```bash
# Install from npm
pi install npm:@patimweb/pi-localsend

# Install from local path during development
pi install /path/to/pi-localsend
```

## Quick Start

Nothing to configure — every setting has a working default.

```
# See what is on the network (LocalSend must be open on the other device)
localsend_devices

# Send
localsend_send:
  to: Pats iPhone
  files: [/Users/pat/report.pdf]

# Receive one transfer
localsend_receive:
  timeoutSeconds: 300
```

`localsend_receive` prints a PIN and the address to use, then waits. Enter the PIN on the sending device.

## No background service

This is the design constraint the extension is built around: **there is no daemon**. Sockets are open only while a tool is running, and each tool closes what it opened before it returns.

| Tool | What it opens | When it closes |
|------|---------------|----------------|
| `localsend_devices` | UDP socket + short-lived HTTP server | when the scan ends (seconds) |
| `localsend_send` | outbound connections only | when the transfer ends |
| `localsend_receive` | HTTP(S) server + announcement socket | after one transfer, or at the timeout |

`localsend_receive` accepts exactly one session and then shuts down. Nothing survives the tool call, and nothing survives the pi session.

## Tools

| Tool | Description |
|------|-------------|
| `localsend_setup` | Change alias, download directory, PIN policy, transport, port. Optional. |
| `localsend_status` | Show current settings and the addresses other devices can reach this machine at. Opens no ports. |
| `localsend_devices` | Scan the network for LocalSend devices and list their aliases and addresses. |
| `localsend_send` | Send files or a text snippet to a device, by alias or IP address. |
| `localsend_receive` | Wait for exactly one incoming transfer, save the files, shut down. |

### Sending

```yaml
localsend_send:
  to: Pats iPhone            # alias from localsend_devices
  files:
    - /Users/pat/report.pdf
    - /Users/pat/screenshots  # a directory sends the files directly inside it
  # pin: "123456"             # if the receiving device asks for one
```

Text goes straight across without touching disk first:

```yaml
localsend_send:
  to: 192.168.1.42
  text: "The staging URL is https://staging.example.com"
  # textFileName: staging.txt
```

When discovery does not work (guest Wi-Fi, VPN, firewall), give an address instead of an alias. Direct addresses default to port 53317 and `https`, which is what the LocalSend app uses.

### Receiving

```yaml
localsend_receive:
  timeoutSeconds: 300         # default 5 minutes, max 1 hour
  # downloadDir: ~/Desktop    # just for this transfer
  # noPin: true               # accept without a PIN
```

The call blocks and returns the listening port, this machine's addresses, and a generated six-digit PIN. One window accepts one transfer; several files in a single send are fine.

Incoming file names are attacker-controlled, so they are sanitised before anything is written: path separators and traversal are stripped, and a name that collides gets a ` (2)` suffix rather than overwriting. A sender that pushes more bytes than it declared is cut off.

## Commands

| Command | Description |
|---------|-------------|
| `/localsend` | Scan the network for LocalSend devices. |
| `/localsend-receive [minutes]` | Open a receive window (default 5 minutes). |

## Skills

| Skill | Purpose |
|-------|---------|
| `localsend-transfer` | Finding devices, confirming the right target before sending, surfacing the PIN while the receiver is still waiting, and what to check when a device does not appear. |

## Configuration

Settings are saved to `~/.pi/localsend-config.json` (mode `0600`) by `localsend_setup`. Only overrides are stored; anything unset falls back to a default.

| Setting | Default |
|---------|---------|
| `alias` | `pi on <hostname>` |
| `downloadDir` | `~/Downloads`, or the home directory if that does not exist |
| `deviceType` | `desktop` |
| `protocol` | `http` |
| `port` | `0` — a free port is picked per transfer |
| `requirePin` | `true` |

### Encryption

LocalSend normally runs over HTTPS with a self-signed certificate, where the device fingerprint is the hash of that certificate. Node cannot generate certificates on its own, and a crypto library is a lot of dependency for one optional feature, so:

- **`protocol: http`** (default) works everywhere with no dependencies. The protocol supports it; the fingerprint is then a stable random id.
- **`protocol: https`** generates a self-signed certificate with `openssl` on first use and caches it in `~/.pi/localsend/`. If `openssl` is not installed the transfer falls back to http and says so rather than failing.

When connecting *to* a peer over https, certificate chain validation is off by design: LocalSend peers are self-signed, and the protocol's trust anchor is the fingerprint, not a CA.

### Port 53317

The LocalSend desktop app owns UDP/TCP 53317 while it runs. This extension listens on a free port instead and advertises it in its announcement, so both can coexist. The one consequence is that scans may miss devices that answer by multicast rather than HTTP; the tools report that as a note.

## Development

```bash
npm install
npm test
npm run test:coverage
```

The test suite includes a real loopback transfer: it starts the receiver, sends files to it through the send client, and asserts on what landed on disk — including path traversal, duplicate names, PIN rejection and the concurrent-session case.

## License

MIT
