#!/usr/bin/env python3
"""
Wallpaper Switcher - Storage Local
Suporta imagens como wallpaper no GNOME.
"""

import os
import sys
import json
import random
import time
import calendar
import subprocess
import hashlib
import shutil
import re
from pathlib import Path
from datetime import datetime, timedelta

try:
    from PIL import Image
    HAS_PILLOW = True
except ImportError:
    HAS_PILLOW = False

CONFIG_DIR = Path.home() / ".config" / "wallpaper-switcher"
STORAGE_DIR = CONFIG_DIR / "storage"
PHOTOS_DIR = STORAGE_DIR / "photos"
WALLPAPERS_DIR = CONFIG_DIR / "wallpapers"
METADATA_FILE = CONFIG_DIR / "metadata.json"
CONFIG_FILE = CONFIG_DIR / "config.json"
SYSTEMD_USER_DIR = Path.home() / ".config" / "systemd" / "user"
SERVICE_UNIT = SYSTEMD_USER_DIR / "wallpaper-switcher.service"
TIMER_UNIT = SYSTEMD_USER_DIR / "wallpaper-switcher.timer"

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp"}
VIDEO_EXTENSIONS = {".mp4", ".mkv", ".webm"}

HIDAMARI_VIDEOS_DIR = Path.home() / "Videos" / "Hidamari"
HIDAMARI_DBUS_DEST = "io.github.jeffshee.Hidamari.server"
HIDAMARI_DBUS_PATH = "/io/github/jeffshee/Hidamari/server"
HIDAMARI_DBUS_IFACE = "io.github.jeffshee.hidamari.server"

DEFAULT_CONFIG = {
    "timer_hours": 2,
    "timer_minutes": 0,
    "timer_mode": "interval",
    "jpeg_quality": 80,
    "max_width": 3840,
    "current_mode": "photo",
}


def load_metadata():
    if METADATA_FILE.exists():
        with open(METADATA_FILE) as f:
            data = json.load(f)
        if "current_id" not in data:
            data["current_id"] = None
        if "images" not in data:
            data["images"] = []
        if "videos" in data:
            data.pop("videos")
        return data
    return {"images": [], "current_id": None}


def save_metadata(data):
    with open(METADATA_FILE, "w") as f:
        json.dump(data, f, indent=2)


def load_config():
    if CONFIG_FILE.exists():
        with open(CONFIG_FILE) as f:
            return {**DEFAULT_CONFIG, **json.load(f)}
    return DEFAULT_CONFIG.copy()


def save_config(cfg):
    with open(CONFIG_FILE, "w") as f:
        json.dump(cfg, f, indent=2)


def is_image_file(path):
    return Path(path).suffix.lower() in IMAGE_EXTENSIONS


# ──────────────────────────────────────────────
# Image compression
# ──────────────────────────────────────────────

def compress_image(src_path, dest_path, quality=80, max_width=3840):
    if not HAS_PILLOW:
        shutil.copy2(src_path, dest_path)
        return True
    try:
        img = Image.open(src_path)
        if img.mode in ("RGBA", "P", "LA"):
            bg = Image.new("RGB", img.size, (0, 0, 0))
            if img.mode == "P":
                img = img.convert("RGBA")
            bg.paste(img, mask=img.split()[-1] if "A" in img.mode else None)
            img = bg
        elif img.mode != "RGB":
            img = img.convert("RGB")
        if img.width > max_width:
            ratio = max_width / img.width
            new_h = int(img.height * ratio)
            img = img.resize((max_width, new_h), Image.LANCZOS)
        img.save(dest_path, "JPEG", quality=quality, optimize=True)
        return True
    except Exception as e:
        print(f"  ERRO ao comprimir: {e}")
        return False


def set_wallpaper(filepath):
    uri = f"file://{filepath}"
    subprocess.run(["gsettings", "set", "org.gnome.desktop.background",
                     "picture-uri", uri], check=True)
    subprocess.run(["gsettings", "set", "org.gnome.desktop.background",
                     "picture-uri-dark", uri], check=True)
    subprocess.run(["gsettings", "set", "org.gnome.desktop.background",
                     "picture-options", "zoom"], check=True)
    print(f"  Wallpaper setado: {Path(filepath).name}")


def clean_old_wallpapers(keep=20):
    if not WALLPAPERS_DIR.exists():
        return
    files = sorted(WALLPAPERS_DIR.glob("current_wallpaper.*"),
                    key=lambda f: f.stat().st_mtime)
    if len(files) > keep:
        for f in files[:-keep]:
            f.unlink()


# ──────────────────────────────────────────────
# Hidamari video integration
# ──────────────────────────────────────────────

def get_video_files():
    """Lista videos disponiveis na pasta do Hidamari."""
    if not HIDAMARI_VIDEOS_DIR.exists():
        return []
    return sorted(
        f for f in HIDAMARI_VIDEOS_DIR.iterdir()
        if f.is_file() and f.suffix.lower() in VIDEO_EXTENSIONS
    )


def set_video_via_dbus(video_path):
    """Envia video para o Hidamari via D-Bus."""
    try:
        result = subprocess.run(
            [
                "gdbus", "call", "--session",
                "--dest", HIDAMARI_DBUS_DEST,
                "--object-path", HIDAMARI_DBUS_PATH,
                "--method", f"{HIDAMARI_DBUS_IFACE}.video",
                str(video_path), "Default",
            ],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            print(f"ERRO D-Bus: {result.stderr.strip()}")
            return False
        print(f"  Video Hidamari: {Path(video_path).name}")
        return True
    except FileNotFoundError:
        print("ERRO: gdbus nao encontrado. Instale gdbus.")
        return False
    except subprocess.TimeoutExpired:
        print("ERRO: D-Bus timeout.")
        return False


def cmd_set_video(args):
    """Escolhe video aleatorio da pasta Hidamari e envia via D-Bus."""
    videos = get_video_files()
    if not videos:
        print(f"ERRO: Nenhum video em {HIDAMARI_VIDEOS_DIR}")
        sys.exit(1)

    chosen = random.choice(videos)
    if not set_video_via_dbus(chosen):
        sys.exit(1)

    cfg = load_config()
    cfg["current_mode"] = "video"
    cfg["current_video"] = chosen.name
    save_config(cfg)
    rearm_timer()


def cmd_list_videos(args):
    """Lista videos da pasta Hidamari como JSON."""
    videos = get_video_files()
    result = []
    for v in videos:
        stat = v.stat()
        result.append({
            "name": v.name,
            "path": str(v),
            "size": stat.st_size,
        })
    print(json.dumps(result))


def cmd_set_mode(args):
    """Altera o modo (photo/video) e salva na config."""
    cfg = load_config()
    cfg["current_mode"] = args.mode
    save_config(cfg)
    print(json.dumps({"ok": True, "mode": args.mode}))


# ──────────────────────────────────────────────
# Timer (agendamento via equipa de UTC naive, sem fuso.
# Base nunca toca em timezone: so aritmetica em UTC.)
# ──────────────────────────────────────────────

def _utc_from_ms(base_ms):
    """Converte epoch ms para datetime NAIVE em UTC (zero fuso)."""
    return datetime(1970, 1, 1) + timedelta(milliseconds=base_ms)


def _utc_epoch_ms(dt_naive_utc):
    """Converte datetime naive-UTC para epoch ms, SEM usar o fuso local."""
    return int(calendar.timegm(dt_naive_utc.timetuple()) * 1000)


def _is_timer_active():
    try:
        out = subprocess.run(
            ["systemctl", "--user", "is-active", "wallpaper-switcher.timer"],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
        return out == "active"
    except Exception:
        return False


def _write_units(calendar):
    """Grava service + timer no systemd user e recarrega os daemons."""
    script = os.path.realpath(__file__)
    SYSTEMD_USER_DIR.mkdir(parents=True, exist_ok=True)
    SERVICE_UNIT.write_text(f"""[Unit]
Description=Wallpaper Switcher
After=graphical-session.target

[Service]
Type=oneshot
KillMode=process
ExecStart={sys.executable} "{script}" set
""")
    TIMER_UNIT.write_text(f"""[Unit]
Description=Timer do Wallpaper Switcher

[Timer]
OnCalendar={calendar}
Persistent=true

[Install]
WantedBy=timers.target
""")
    subprocess.run(["systemctl", "--user", "daemon-reload"], timeout=5)


def schedule_core(base_ms=None, hours=2, minutes=0, mode="interval", query=False):
    """Fonte de verdade do proximo disparo: aritmetica UTC naive pura.

    - interval: next = base_ms + (hours*60 + minutes) (min 1min, absoluto)
    - daily:    next = proxima ocorrencia de HH:MM UTC apos base_ms

    Se query=False, grava o unit e rearma o timer do systemd
    (restart apenas se o timer estiver ATIVO - nunca liga sozinho).
    Retorna dict JSON-compativel para impressao.
    """
    if base_ms is None:
        base_ms = int(time.time() * 1000)
    base_dt = _utc_from_ms(base_ms)

    minutes = max(0, min(59, int(minutes or 0)))
    if mode == "daily":
        hours = max(0, min(23, int(hours or 0)))
        nxt = base_dt.replace(hour=hours, minute=minutes, second=0, microsecond=0)
        if nxt <= base_dt:
            nxt += timedelta(days=1)
        cal = "*-*-* %02d:%02d:00 UTC" % (hours, minutes)
    else:
        hours = max(0, int(hours or 0))
        total_minutes = minutes + hours * 60
        secs = max(1, total_minutes) * 60
        nxt = base_dt + timedelta(seconds=secs)
        cal = nxt.strftime("%Y-%m-%d %H:%M:%S UTC")

    active = False
    if not query:
        _write_units(cal)
        active = _is_timer_active()
        if active:
            subprocess.run(["systemctl", "--user", "restart", "wallpaper-switcher.timer"], timeout=5)

    return {
        "ok": True,
        "active": active,
        "mode": mode,
        "hours": hours,
        "minutes": minutes,
        "next": {
            "year": nxt.year,
            "month": nxt.month,
            "day": nxt.day,
            "hour": nxt.hour,
            "minute": nxt.minute,
            "second": nxt.second,
        },
        "next_epoch_ms": _utc_epoch_ms(nxt),
        "base_epoch_ms": int(base_ms),
    }


def cmd_schedule(args):
    """Imprime o JSON do proximo disparo (fonte de verdade)."""
    res = schedule_core(
        base_ms=args.base,
        hours=args.hours,
        minutes=args.minutes,
        mode=args.mode,
        query=args.query,
    )
    print(json.dumps(res))


def rearm_timer():
    """Reagenda o proximo disparo a partir do proprio relogio (UTC naive).
    Usado no fim do 'set': mantem o ciclo vivo sem a GUI aberta.
    So age se o timer estiver habilitado."""
    cfg = load_config()
    mode = cfg.get("timer_mode", "interval")

    try:
        enabled = subprocess.run(
            ["systemctl", "--user", "is-enabled", "wallpaper-switcher.timer"],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
    except Exception:
        return
    if enabled != "enabled":
        return

    try:
        schedule_core(
            base_ms=None,
            hours=cfg.get("timer_hours", 2),
            minutes=cfg.get("timer_minutes", 0),
            mode=mode,
        )
    except Exception:
        pass


# ──────────────────────────────────────────────
# Commands
# ──────────────────────────────────────────────

def cmd_add(args):
    """Adiciona imagem ao storage."""
    src = Path(args.image)
    if not src.exists():
        print(f"ERRO: Arquivo nao encontrado: {src}")
        sys.exit(1)

    if not is_image_file(str(src)):
        print("ERRO: Arquivo nao e uma imagem valida.")
        print(f"  Formatos suportados: {', '.join(sorted(IMAGE_EXTENSIONS))}")
        sys.exit(1)

    PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
    metadata = load_metadata()
    cfg = load_config()

    file_hash = hashlib.md5(src.read_bytes()).hexdigest()[:8]
    timestamp = int(datetime.now().timestamp())
    wp_id = f"{timestamp}_{file_hash}"

    dest_filename = f"{wp_id}.jpg"
    dest_path = PHOTOS_DIR / dest_filename

    quality = cfg.get("jpeg_quality", 80)
    max_width = cfg.get("max_width", 3840)
    print(f"Comprimindo {src.name} (qualidade={quality}, max_width={max_width})...")

    if not compress_image(str(src), str(dest_path), quality, max_width):
        print("ERRO: Falha ao comprimir imagem")
        sys.exit(1)

    original_size = src.stat().st_size
    compressed_size = dest_path.stat().st_size
    ratio = (1 - compressed_size / original_size) * 100 if original_size > 0 else 0

    entry = {
        "id": wp_id,
        "original_name": src.name,
        "filename": dest_filename,
        "added": datetime.now().isoformat(),
        "original_size": original_size,
        "compressed_size": compressed_size,
        "type": "photo",
    }
    metadata["images"].append(entry)
    save_metadata(metadata)

    print(f"  Adicionado: {src.name}")
    print(f"  Original: {original_size / 1024 / 1024:.1f}MB -> Comprimido: {compressed_size / 1024 / 1024:.1f}MB ({ratio:.0f}% menor)")
    print(f"  ID: {wp_id}")


def cmd_list(args):
    """Lista todas as imagens no storage."""
    metadata = load_metadata()
    images = metadata.get("images", [])

    if not images:
        print("Nenhuma imagem no storage.")
        return

    print(f"--- Fotos ({len(images)}) ---")
    for i, img in enumerate(images, 1):
        orig = img.get("original_size", 0) / 1024 / 1024
        comp = img.get("compressed_size", 0) / 1024 / 1024
        print(f"  {i}. {img['original_name']} ({comp:.1f}MB) [{img['id']}]")


def cmd_set(args):
    """Escolhe wallpaper aleatorio (diferente do atual) e seta.
    Checa current_mode: photo -> gsettings, video -> Hidamari D-Bus."""
    cfg = load_config()
    current_mode = cfg.get("current_mode", "photo")

    if current_mode == "video":
        cmd_set_video(args)
        return

    metadata = load_metadata()
    current_id = metadata.get("current_id")

    images = metadata.get("images", [])

    available = [img for img in images if img["id"] != current_id]
    if not available:
        available = images[:]

    if not available:
        print("Nenhuma imagem disponivel. Use 'add'.")
        sys.exit(1)

    WALLPAPERS_DIR.mkdir(parents=True, exist_ok=True)

    chosen = random.choice(available)
    filepath = PHOTOS_DIR / chosen["filename"]
    if not filepath.exists():
        print(f"ERRO: Arquivo nao encontrado: {chosen['filename']}")
        metadata["images"] = [i for i in images if i["id"] != chosen["id"]]
        save_metadata(metadata)
        sys.exit(1)

    if HAS_PILLOW:
        pil_img = Image.open(str(filepath))
        temp_path = WALLPAPERS_DIR / "current_wallpaper.jpg"
        pil_img.save(str(temp_path), "JPEG", quality=95)
        set_wallpaper(str(temp_path))
    else:
        set_wallpaper(str(filepath))

    metadata["current_id"] = chosen["id"]
    save_metadata(metadata)
    print(f"  {chosen['original_name']} [FOTO]")

    rearm_timer()


def cmd_remove(args):
    """Remove imagem do storage."""
    metadata = load_metadata()
    target_id = args.id

    for img in metadata.get("images", []):
        if img["id"] == target_id or img["original_name"] == target_id:
            filepath = PHOTOS_DIR / img["filename"]
            if filepath.exists():
                filepath.unlink()
            metadata["images"] = [i for i in metadata["images"] if i["id"] != img["id"]]
            save_metadata(metadata)
            print(f"  Removido: {img['original_name']}")
            return

    print(f"ERRO: Imagem '{target_id}' nao encontrada.")


def cmd_status(args):
    """Mostra status."""
    metadata = load_metadata()
    cfg = load_config()
    images = metadata.get("images", [])
    videos = get_video_files()

    print(f"Modo: {cfg.get('current_mode', 'photo').upper()}")
    print(f"Fotos no storage: {len(images)}")
    if images:
        total = sum(img.get("compressed_size", 0) for img in images)
        print(f"Tamanho fotos: {total / 1024 / 1024:.1f}MB")
    print(f"Videos Hidamari: {len(videos)}")
    print(f"Qualidade JPEG: {cfg.get('jpeg_quality', 80)}")
    print(f"Max largura: {cfg.get('max_width', 3840)}px")
    print(f"Timer: {cfg.get('timer_hours', 2)}h {cfg.get('timer_minutes', 0)}min ({cfg.get('timer_mode', 'interval')})")
    if cfg.get("timer_mode") == "daily":
        print("  (modo diario: horario armazenado em UTC, fuso so na interface)")


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Wallpaper Switcher - Storage Local")
    sub = parser.add_subparsers(dest="command", help="Comando")

    p_add = sub.add_parser("add", help="Adiciona imagem ao storage")
    p_add.add_argument("image", type=str, help="Caminho da imagem")

    sub.add_parser("list", help="Lista imagens no storage")
    sub.add_parser("set", help="Troca wallpaper (aleatorio, photo ou video)")
    sub.add_parser("list-videos", help="Lista videos da pasta Hidamari")
    sub.add_parser("set-video", help="Troca video via Hidamari D-Bus")

    p_set_mode = sub.add_parser("set-mode", help="Altera modo (photo/video)")
    p_set_mode.add_argument("mode", type=str, choices=["photo", "video"])

    p_remove = sub.add_parser("remove", help="Remove imagem do storage")
    p_remove.add_argument("id", type=str, help="ID ou nome da imagem")

    sub.add_parser("status", help="Mostra status")

    p_schedule = sub.add_parser("schedule", help="Calcula/rearma o agendamento (UTC naive)")
    p_schedule.add_argument("--base", type=int, default=None, help="Epoch ms (frontend); omite=agora")
    p_schedule.add_argument("--hours", type=int, default=2, help="Horas (intervalo ou hora UTC no diario)")
    p_schedule.add_argument("--minutes", type=int, default=0, help="Minutos (intervalo ou minuto UTC no diario)")
    p_schedule.add_argument("--mode", type=str, default="interval", choices=["interval", "daily"])
    p_schedule.add_argument("--query", action="store_true", help="So calcula/imprime, nao toca no systemd")

    p_config = sub.add_parser("config", help="Altera configuracao")
    p_config.add_argument("--quality", type=int, help="Qualidade JPEG (1-100)")
    p_config.add_argument("--max-width", type=int, help="Largura maxima em pixels")
    p_config.add_argument("--timer", type=str, help="Intervalo (ex: 2h, 30min)")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    if args.command == "add":
        cmd_add(args)
    elif args.command == "list":
        cmd_list(args)
    elif args.command == "set":
        cmd_set(args)
    elif args.command == "list-videos":
        cmd_list_videos(args)
    elif args.command == "set-video":
        cmd_set_video(args)
    elif args.command == "set-mode":
        cmd_set_mode(args)
    elif args.command == "remove":
        cmd_remove(args)
    elif args.command == "status":
        cmd_status(args)
    elif args.command == "schedule":
        cmd_schedule(args)
    elif args.command == "config":
        cfg = load_config()
        if args.quality:
            cfg["jpeg_quality"] = max(1, min(100, args.quality))
        if args.max_width:
            cfg["max_width"] = args.max_width
        if args.timer:
            m = re.match(r"(?:(\d+)h)?(?:(\d+)min)?", args.timer)
            if m:
                cfg["timer_hours"] = int(m.group(1) or 0)
                cfg["timer_minutes"] = int(m.group(2) or 0)
        save_config(cfg)
        print("Configuracao salva!")


if __name__ == "__main__":
    main()