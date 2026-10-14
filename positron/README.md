# Notes

A bar button for the notes window of [positron](https://github.com/Profiidev/positron).
It runs `positron ipc toggle`, so positron has to be running: start it with the
session, e.g. `exec-once = positron` in Hyprland. The window closes on a click
outside of it, which needs the positron version that draws a backdrop behind it.

Add `positron:notes` to a bar. The service also answers
`corona ipc plugin positron show|hide|toggle`, for a key binding:

```lua
hl.bind("SUPER + N", hl.dsp.exec_cmd("corona ipc plugin positron toggle"))
```

Permissions: it may run `positron`, and gives it `PATH`, `XDG_RUNTIME_DIR` and
`WAYLAND_DISPLAY` to find the socket. A notification says when positron is not
reachable.
