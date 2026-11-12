#!/usr/bin/env python3
"""Убрать dsh-remote из профиля DSH: зависимость, бандл и симлинк node_modules.

    python3 bin/uninstall-remote.py <package.json профиля> <имя пакета> <каталог профиля> <dry-run 0|1>

Идемпотентно: повторный запуск ничего не меняет. Чужие зависимости, бандлы и
реальные каталоги в node_modules не трогает — только наш симлинк.
"""
import json
import os
import sys


def main() -> int:
    manifest_path, name, profile_dir, dry_run = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)

    deps = manifest.get("dependencies") or {}
    had_dep = name in deps
    deps.pop(name, None)
    manifest["dependencies"] = deps

    profile = manifest.setdefault("dsh", {}).setdefault("profile", {})
    bundles = profile.get("bundles") or []
    had_bundle = name in bundles
    profile["bundles"] = [item for item in bundles if item != name]

    link = os.path.join(profile_dir, "node_modules", name)
    is_link = os.path.islink(link)
    exists = os.path.exists(link)

    if dry_run:
        print(f"  • зависимость: {'удалить' if had_dep else 'уже нет'}")
        print(f"  • бандл:       {'удалить' if had_bundle else 'уже нет'}")
        state = "удалить" if is_link else ("НЕ симлинк — не трогаю" if exists else "уже нет")
        print(f"  • симлинк:     {state}")
        print("dry-run: ничего не изменено")
        return 0

    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    if is_link:
        os.unlink(link)
        print("  • симлинк node_modules/%s удалён" % name)
    elif exists:
        print("  • node_modules/%s — не симлинк, оставлен как есть (проверьте руками)" % name)

    print("  • зависимость: удалена" if had_dep else "  • зависимости не было")
    print("  • бандл: удалён" if had_bundle else "  • бандла не было")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
