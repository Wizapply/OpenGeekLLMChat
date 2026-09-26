#!/usr/bin/env python3
"""
OpenGeekLLMChat — パスワードハッシュ生成ツール

使い方:
  python3 tools/hashpass.py
  python3 tools/hashpass.py mypassword

生成されたMD5ハッシュを config.json の "password" に設定してください。
"""

import hashlib
import sys
import getpass


def md5_hash(password: str) -> str:
    return hashlib.md5(password.encode("utf-8")).hexdigest()


def main():
    if len(sys.argv) > 1:
        password = sys.argv[1]
    else:
        password = getpass.getpass("パスワードを入力: ")
        confirm = getpass.getpass("もう一度入力: ")
        if password != confirm:
            print("エラー: パスワードが一致しません")
            sys.exit(1)

    h = md5_hash(password)
    print()
    print(f"  パスワード: {password}")
    print(f"  MD5ハッシュ: {h}")
    print()
    print(f'  config.json に以下を設定してください:')
    print(f'  "password": "{h}"')
    print()


if __name__ == "__main__":
    main()
