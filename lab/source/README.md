# Stick Lab source code

Stick Lab is made by Stick Hubs. It is based on **TurboWarp** (https://turbowarp.org), which is a modified
version of Scratch 3. TurboWarp is licensed under the GNU General Public License v3, so Stick Lab is too.
The full licence is in `LICENSE.txt`.

Stick Lab is not affiliated with Scratch, the Scratch Team, the Scratch Foundation or TurboWarp.

## How to build it

1. Get TurboWarp's editor source at commit `7738389`:
   `git clone https://github.com/TurboWarp/scratch-gui && cd scratch-gui && git checkout 7738389`
2. Apply the Stick Lab changes: `git apply stick-lab-gui.patch`
3. `npm ci --ignore-scripts`, then `NODE_ENV=production npx webpack`. The editor ends up in `build/`.

## Desktop apps

- `desktop/`: the Electron app (`main.js`, `package.json`). Put the built editor in `desktop/gui/`,
  then run `npx electron-builder --win dir` or `npx electron-builder --mac zip`.
- `installer/stick_lab.nsi`: the Windows installer script, built with
  `makensis -DAPP_DIR=<win-unpacked folder> -DOUT_FILE=stick_lab.exe stick_lab.nsi`.

## The .sl file format

A `.sl` file is a Scratch 3 project (`.sb3` zip) with the 8-byte header `STICKLAB`, a version byte (1),
and then the zip data scrambled with a 16-byte XOR key. See `src/lib/sl-format.js` in the patch.
Stick Lab also still opens `.sb3`, `.sb2` and `.sb` files.
