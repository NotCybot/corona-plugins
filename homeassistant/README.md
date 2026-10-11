# Home Assistant

A bar widget and panel for Home Assistant: the entities you pin, grouped into lights, switches & locks, sensors and automations, with switches, light sliders (brightness, color temperature, hue) and run/trigger buttons.

## Setup

1. In Home Assistant, create a long-lived access token (Profile → Security).
2. In the plugin settings, enter the **URL** and paste the **token**. A server on your LAN needs its IP in the URL (e.g. `http://192.168.1.10:8123`): corona refuses a host name that resolves to a private address. A public URL (Nabu Casa, a reverse proxy) works by name.
3. Add the widget `homeassistant:home` to a bar, open the panel and pin entities under **Manage entities**.

## How it works

- The service keeps one WebSocket to `/api/websocket` and subscribes with `subscribe_entities` to the pinned entities only; Home Assistant pushes every change. Nothing polls.
- While Home Assistant is unreachable it retries after 2 s, doubling up to 2 minutes, and at once when the URL or token changes. A refused token waits for a new one.
- Pins are the **Monitored entities** list setting, editable here or in the settings app; changing them resubscribes.
- **Manage entities** fetches `get_states` once when opened and shows the first 100 matches of the search.
