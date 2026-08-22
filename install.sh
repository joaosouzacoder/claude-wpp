#!/usr/bin/env bash
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIDADE="$HOME/.config/systemd/user/claude-wpp.service"

if [ ! -f "$RAIZ/config.json" ]; then
  echo "Falta o config.json. Copie o config.example.json e ponha o seu token." >&2
  exit 1
fi

mkdir -p "$(dirname "$UNIDADE")"
cp "$RAIZ/systemd/claude-wpp.service" "$UNIDADE"
systemctl --user daemon-reload
systemctl --user enable claude-wpp.service

echo
echo "Unidade instalada em $UNIDADE"
echo
echo "Falta você rodar, uma vez só, com sudo:"
echo "  sudo loginctl enable-linger $USER"
echo
echo "Sem isso o serviço morre quando você desloga e não sobe no boot."
echo
echo "Depois: npm run pair  (leia o QR) e  systemctl --user start claude-wpp"
