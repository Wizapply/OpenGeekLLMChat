#!/bin/bash
# OpenGeekLLMChat - 自己署名証明書生成スクリプト
#
# 使い方:
#   ./tools/generate-cert.sh                                            # localhostのみ
#   ./tools/generate-cert.sh llm.example.com                            # ホスト名1つ
#   ./tools/generate-cert.sh 192.168.10.201 llm.example.com             # 複数指定（スペース区切り）
#   ./tools/generate-cert.sh llm.example.com 192.168.10.201 10.0.0.5    # 3つ以上もOK
#
# cert.pem / key.pem がリポジトリ直下 (server.js と同じ場所) に生成されます。
# どこから実行しても同じ場所に出ます。再起動で自動的にHTTPSモードになります。

set -e

# このスクリプトは tools/ にあるので、1つ上がリポジトリ直下
cd "$(dirname "$0")/.."

DAYS=365

# デフォルト: localhostのみ
if [ $# -eq 0 ]; then
  HOSTS=("localhost")
else
  HOSTS=("$@")
fi

echo "Generating self-signed certificate for:"
for h in "${HOSTS[@]}"; do
  echo "  - $h"
done
echo "Valid for: $DAYS days"
echo ""

# OpenSSL設定ファイル生成
CNF=$(mktemp)
cat > "$CNF" <<EOF
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = ${HOSTS[0]}

[v3_req]
keyUsage = keyEncipherment, dataEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
EOF

# 追加ホストをSANに入れる
dns_idx=2
ip_idx=2
for h in "${HOSTS[@]}"; do
  if [ "$h" = "localhost" ]; then continue; fi
  if [[ "$h" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "IP.$ip_idx = $h" >> "$CNF"
    ip_idx=$((ip_idx+1))
  else
    echo "DNS.$dns_idx = $h" >> "$CNF"
    dns_idx=$((dns_idx+1))
  fi
done

openssl req -x509 -newkey rsa:4096 \
  -keyout key.pem \
  -out cert.pem \
  -days $DAYS \
  -nodes \
  -config "$CNF"

rm -f "$CNF"

chmod 600 key.pem
chmod 644 cert.pem

echo ""
echo "✓ Generated: cert.pem, key.pem"
echo ""
echo "Accessible URLs (after server restart):"
for h in "${HOSTS[@]}"; do
  echo "  https://$h:3000"
done
echo "  https://localhost:3000"
echo ""
echo "Next: npm start"
