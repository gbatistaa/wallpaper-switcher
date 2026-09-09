#!/bin/sh
# after-install (deb) - cria comandos no PATH apontando para os binarios em /opt.
# Variaveis usadas localmente apenas (path fixo do produto).

SYSBIN=/usr/bin
RES='/opt/Wallpaper Switcher/resources/wallpaper-switcher.py'
APP='/opt/Wallpaper Switcher/wallpaper-switcher-gui'

if [ -f "$RES" ]; then
    chmod 755 "$RES"
    ln -sf "$RES" "$SYSBIN/wallpaper-switcher"
    ln -sf "$RES" "$SYSBIN/wpg"
fi

if [ -f "$APP" ]; then
    ln -sf "$APP" "$SYSBIN/wallpaper-switcher-gui"
fi

# Garante a entrada de menu com --no-sandbox (espaco no caminho quebra o sandbox).
DESKTOP=/usr/share/applications/wallpaper-switcher-gui.desktop
if [ -f "$DESKTOP" ] && ! grep -q -- '--no-sandbox' "$DESKTOP"; then
    sed -i 's#^Exec=.*$#Exec="/opt/Wallpaper Switcher/wallpaper-switcher-gui" --no-sandbox %U#' "$DESKTOP"
fi

# Electron-builder instala o icone em hicolor/0x0 (escala invalida).
# Gera tamanhos validos no tema hicolor para o menu exibir o icone.
SRC_ICON=/usr/share/icons/hicolor/0x0/apps/wallpaper-switcher-gui.png
if [ -f "$SRC_ICON" ]; then
    python3 - "$SRC_ICON" <<'PYEOF'
import os
import sys
from PIL import Image

img = Image.open(sys.argv[1]).convert("RGBA")
base = "/usr/share/icons/hicolor"
for s in (16, 24, 32, 48, 64, 128, 256):
    d = os.path.join(base, "%dx%d" % (s, s), "apps")
    try:
        os.makedirs(d)
    except OSError:
        pass
    img.resize((s, s), Image.LANCZOS).save(os.path.join(d, "wallpaper-switcher-gui.png"))
PYEOF
    gtk-update-icon-cache -f /usr/share/icons/hicolor >/dev/null 2>&1 || true
fi

exit 0