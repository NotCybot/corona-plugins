# Home Assistant

A bar widget and panel for Home Assistant: the entities you pin, grouped into lights, switches & locks, sensors, scenes and automations, with switches, light sliders (brightness, color temperature, hue), run/trigger buttons and On/Off for scenes.

## Setup

1. In Home Assistant, create a long-lived access token (Profile → Security).
2. In the plugin settings, enter the **URL** and paste the **token**. The URL may name a server in your local network (`http://homeassistant.local:8123`), an IP or a public URL (Nabu Casa, a reverse proxy): the plugin asks for `network.lan_hosts`, which lets that one name resolve to a private address.
3. Add the widget `homeassistant:home` to a bar, open the panel and pin entities under **Manage entities**.

## How it works

- The service keeps one WebSocket to `/api/websocket` and subscribes with `subscribe_entities` to the pinned entities only; Home Assistant pushes every change. Nothing polls.
- While Home Assistant is unreachable it retries after 2 s, doubling up to 2 minutes, and at once when the URL or token changes. A refused token waits for a new one.
- Pins are the **Monitored entities** list setting, editable here or in the settings app; changing them resubscribes.
- **Manage entities** fetches `get_states` once when opened and shows the first 100 matches of the search.
- A scene's **On** activates it (`scene.turn_on`). Home Assistant has no off for a scene, so **Off** turns off the entities the scene lists in its `entity_id` attribute (`homeassistant.turn_off`); a scene that lists none, as some integrations' scenes do, has Off disabled.
