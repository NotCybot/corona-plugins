# Tailscale

A bar widget and panel for tailscaled: connection state, devices, exit nodes, Taildrop and preferences.

## Setup

1. Let your user change tailscaled's settings: `sudo tailscale set --operator=$USER`. Without it, reading works but every action fails with 403.
2. Enable the plugin and add the widget `tailscale:tailscale` to a bar. Click it to open the panel `tailscale:main`.

## How it works

- The service talks to the LocalAPI at `/run/tailscale/tailscaled.sock`. It does not poll: it follows `watch-ipn-bus`, which sends a line on every state, prefs or netmap change, and refreshes the shared state `ts` on each. While tailscaled is down it reconnects with a backoff of 1 s to 60 s. Opening the panel refreshes once more.
- Actions go through `call` to the service, which reports the result in the state `msg`, shown at the bottom of the panel.
- Taildrop uses the `tailscale` CLI (`file cp`, `file get --conflict=rename`). The first receive asks for a folder and keeps it in the **Taildrop folder** setting.
- **SSH** copies `ssh <ip>` to the clipboard; corona has no portable way to open a terminal.
- **Log in** opens the URL tailscaled sends on the bus. The admin console button is off for a custom control server.
