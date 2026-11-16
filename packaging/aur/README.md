# Arch Linux

Build a pacman package from the official x64 `.deb`. This PKGBUILD is maintained in this repository. It is not published to the AUR, and this project does not claim an AUR package name.

The installed package is `open-codesign-bin`. It provides `open-codesign`, puts `open-codesign` on `PATH`, and installs the desktop entry. electron-builder's `.deb` lands in `/opt/Open CoDesign` and does not ship a `/usr/bin` launcher; the PKGBUILD moves that tree to `/opt/open-codesign` and adds the launcher.

`chrome-sandbox` is installed mode `4755`. Electron refuses to start without that mode when unprivileged user namespaces are disabled.

## Install

```sh
sudo pacman -S --needed base-devel
git clone --depth 1 https://github.com/OpenCoworkAI/open-codesign.git
cd open-codesign/packaging/aur
makepkg -si
```

From an existing checkout, `cd packaging/aur && makepkg -si` is enough. `makepkg` checks the `.deb` against the SHA256 published in the release `SHA256SUMS.txt`.

Remove it with:

```sh
sudo pacman -Rns open-codesign-bin
```

## What stays manual

`packaging/update-shas.sh` rewrites `pkgver`, the upstream `/opt` directory name, and the checksums after a release. Nothing in CI submits the package to the AUR. A maintainer who wants to publish it later can run `makepkg --printsrcinfo > .SRCINFO` and push that from their own AUR account.
