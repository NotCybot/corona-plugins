# Phone

A bar widget and panel for KDE Connect: the phone's battery and network, quick actions, media remote, SMS, pairing, and casting the screen with scrcpy.

## Setup

1. Run `kdeconnectd` and pair a phone (from this panel's **Devices** tab, or from KDE Connect itself).
2. Enable the plugin and add the widget `kdeconnect:phone` to a bar. Click it to open the panel `kdeconnect:main`.
3. For **Cast**: install `adb` and `scrcpy`, turn on *Wireless debugging* on the phone, then **Set up** → **Pair** with the pairing port and PIN the phone shows, and **Connect** with the debug port.

## How it works

- The service follows kdeconnectd's D-Bus signals under `/modules/kdeconnect` (property changes, devices appearing, pairing) and the daemon starting or stopping. Each burst of signals refreshes the shared state `kc` once. Nothing polls.
- The seek bar moves on locally once a second while media plays, since KDE Connect reports the position only when it changes.
- Favorites and cast quality are kept in the plugin's `localStorage`.
- Recordings go to the **Recordings folder** setting; the first recording asks for one.
