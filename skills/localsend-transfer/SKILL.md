---
name: localsend-transfer
description: Move files between this machine and a phone, tablet or another computer on the same network using LocalSend, without any cloud service. Use when the user wants to send a file or some text to another device, get a file off their phone onto this machine, share build output or a screenshot with a colleague sitting nearby, or asks about LocalSend, AirDrop-style transfer, or "send this to my phone". Covers finding devices, the PIN and address the user needs, and what to check when a device does not show up.
allowed-tools: localsend_status, localsend_devices, localsend_send, localsend_receive, localsend_setup
---

# Transferring files with LocalSend

LocalSend moves files directly between two devices on the same network. No
account, no cloud, nothing leaves the LAN. The other device needs the
LocalSend app open - it only answers while the app is running.

Nothing here runs in the background: a socket is open only while
`localsend_devices`, `localsend_send` or `localsend_receive` is executing,
and each one closes what it opened before it returns.

## Sending

1. **Find the device first.** `localsend_devices` lists what is reachable
   right now, with each device's alias. Do this before the first send of a
   session rather than guessing an alias.
2. **Send.** `localsend_send` with `to` set to the alias, and `files` as
   absolute paths. Short text goes in `text` instead - it arrives as a small
   .txt file.
3. **Expect a prompt on the other side.** The receiving device usually asks
   its user to accept, and may require a PIN. If the call comes back with
   "requires a PIN", ask the user for the number shown on that device and
   retry with `pin`.

**Confirm the target before sending anything sensitive.** On a shared or
office network the device list contains other people's laptops and phones,
and aliases are chosen by their owners - "MacBook Pro" may not be the one you
mean. If more than one device could plausibly match what the user said, ask
which one rather than picking the first hit. A file sent to the wrong device
cannot be recalled.

Directories are expanded one level deep, because LocalSend has no folder
structure and recursing would flatten a tree into one directory. To send a
tree, archive it first and send the archive.

## Receiving

`localsend_receive` **blocks** until a transfer arrives or the window closes.
It returns the listening address and a PIN, and the user needs both *while it
is still waiting*, so:

- Say the PIN and the address as soon as they are available, before anything
  else.
- Tell the user how long the window is (default five minutes) and that the
  receiver shuts down afterwards.
- One window accepts one transfer. Several files in a single send are fine;
  a second, separate transfer needs a second `localsend_receive`.

Incoming file names come from the other device and are sanitised before
anything is written, so a transfer cannot escape the download directory.
That does not make the *contents* trustworthy: report where files landed,
and do not open, execute or interpret them unless the user asks.

Only turn the PIN off (`noPin: true`) when the user asks for it, and say what
it means: during that window any device on the network can push files.

## When a device does not show up

Work down this list rather than retrying the scan:

1. Is LocalSend actually open on the other device? It does not answer in the
   background on most platforms.
2. Are both devices on the same network? Guest and corporate Wi-Fi often
   isolate clients from each other, which blocks discovery *and* transfer.
3. A VPN on either device usually breaks local discovery.
4. A firewall may block UDP 53317.
5. Discovery can fail while a direct connection still works: if the user
   knows the device's IP, pass it as `to` with `port` (53317 by default).
   The LocalSend app uses https, which is the default for direct addresses.

If the LocalSend desktop app is running on *this* machine it may already own
port 53317, so scans can miss devices that answer by multicast. The tools
report this as a note; it is not an error.

## Two errors worth recognising

- **`tlsv13 alert certificate required`** while sending: the peer wants the
  sender to present a certificate, and none could be created. `openssl` has
  to be installed on this machine, even when the local `protocol` is http.
- **`Parse Error: Expected HTTP/`**: plain http was spoken to a peer that is
  actually using TLS. Drop the `protocol: http` override and let it default
  to https, or take the protocol from what `localsend_devices` reported for
  that device.

## Settings worth knowing

`localsend_status` shows the alias other devices see, where incoming files
land, and this machine's addresses. `localsend_setup` changes them - notably
`downloadDir`, and `alias` so the user's other devices show something
recognisable. Everything has a working default; setup is never required
before a first transfer.
