/**
 * agent_proxy.js — ツール対応 OpenAI 互換エンドポイント
 *
 * 外部APIサーバーを「ツール対応モード」で起動した時に使われる。
 * 通常の外部APIは llama-server を直接公開するだけだが、こちらは
 * server.js 内に Express アプリを立てて別ポートで listen し、
 * /v1/chat/completions を受けてエージェントループ (ツール判断→実行→最終応答) を回す。
 *
 * 対応ツール: ml_* (5), rl_* (6), web_search, read_file, list_files,
 *             search_documents(簡易RAG), gdrive_* (Google Drive)
 * 非対応: generate_image, python実行 (セキュリティ・複雑性のため外部公開しない)
 *
 * server.js から提供される deps オブジェクト経由で内部関数を呼ぶ (循環参照回避)。
 */

const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');

/**
 * ツール対応エージェントサーバーを起動
 * @param {object} opts { port, host, apiKey, modelName, useHttps, certPath, keyPath, tools }
 * @param {object} deps server.js から渡す内部関数群
 * @returns {Promise<{server, close}>}
 */
async function startAgentServer(opts, deps) {
  const {
    port, host = '0.0.0.0', apiKey, modelName,
    useHttps = false, certPath, keyPath,
    tools: enabledTools = ['ml', 'web_search', 'file'],
  } = opts;

  const {
    chatHost, chatPort,          // 内部 llama-server
    log,                          // ログ関数 log(ip, msg)
    appConfig,
    ddgSearch, fetchPageText,     // web検索
    getMlDb, loadMlModels, isValidTableName, isSafeReadOnlySql,  // ML
    ML_MODELS_DIR,
    runMlPredict,                 // ML推論 (server.jsのspawn処理をラップ)
    UPLOADS_DIR,                  // ファイル操作
    listUploadFiles, readUploadFile,
    gdrive,                       // Google Drive クライアント
  } = deps;

  const app = express();

  // JSON ボディパーサー (上限 32MB)
  // パースエラー時は OpenAI 互換のJSONエラーレスポンスを返す (デフォルトはHTML)
  app.use(express.json({ limit: '32mb' }));
  app.use((err, req, res, next) => {
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
      return res.status(400).json({
        error: {
          message: `リクエストボディのJSON解析に失敗しました: ${err.message}`,
          type: 'invalid_request_error',
          hint: 'Content-Type: application/json を指定し、有効なJSONを送信してください',
        },
      });
    }
    next(err);
  });

  // API キー認証 (Bearer)
  // /health はパブリック (生存確認用、認証スキップ)
  app.use((req, res, next) => {
    if (req.path === '/health') return next();  // ヘルスチェックは認証不要
    if (!apiKey) return next();  // キー未設定なら認証なし
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (token !== apiKey) {
      return res.status(401).json({ error: { message: 'Invalid API key', type: 'invalid_request_error' } });
    }
    next();
  });

  // モデル一覧 (OpenAI互換)
  app.get('/v1/models', (req, res) => {
    res.json({
      object: 'list',
      data: [{ id: modelName, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'opengeek-llm' }],
    });
  });

  // メインのチャット補完エンドポイント
  app.post('/v1/chat/completions', async (req, res) => {
    const ip = req.ip || req.socket?.remoteAddress || '-';
    const body = req.body || {};
    const userMessages = body.messages || [];
    const stream = !!body.stream;
    const temperature = body.temperature;
    const maxTokens = body.max_tokens;

    if (!Array.isArray(userMessages) || userMessages.length === 0) {
      return res.status(400).json({ error: { message: 'messages is required', type: 'invalid_request_error' } });
    }

    log(ip, `[エージェントAPI] chat/completions (stream=${stream}, tools=${enabledTools.join(',')})`);

    try {
      // モデルがロード済みか確認 (アイドルアンロード後の再ロード対応)
      // ensureChatModelLoaded は「未起動なら起動開始して false を返す」設計のため、
      // ready=false の場合は起動完了までポーリングで待つ (最大 readyTimeoutMs)
      if (deps.ensureChatModelLoaded) {
        let ready = await deps.ensureChatModelLoaded();
        if (!ready) {
          const startedAt = Date.now();
          const timeoutMs = (deps.appConfig?.llamaServer?.readyTimeoutMs) || 300000;
          while (!ready && Date.now() - startedAt < timeoutMs) {
            await new Promise(r => setTimeout(r, 1000));
            ready = await deps.ensureChatModelLoaded();
          }
          if (!ready) {
            return res.status(503).json({
              error: { message: 'チャットモデルのロードがタイムアウトしました', type: 'service_unavailable' }
            });
          }
        }
      }

      // ツール定義を構築
      const tools = buildToolDefs(enabledTools, appConfig, deps);

      // エージェントループ
      const result = await runAgentLoop({
        messages: userMessages,
        tools,
        temperature,
        maxTokens,
        chatHost, chatPort, modelName,
        deps,
        ip,
      });

      if (stream) {
        // ストリーミング: 最終応答を1チャンクで送る (簡易実装)
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const id = 'chatcmpl-' + Date.now();
        const created = Math.floor(Date.now() / 1000);
        // content を 1 チャンクで
        res.write('data: ' + JSON.stringify({
          id, object: 'chat.completion.chunk', created, model: modelName,
          choices: [{ index: 0, delta: { role: 'assistant', content: result.content }, finish_reason: null }],
        }) + '\n\n');
        res.write('data: ' + JSON.stringify({
          id, object: 'chat.completion.chunk', created, model: modelName,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.json({
          id: 'chatcmpl-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: result.content },
            finish_reason: 'stop',
          }],
          usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          // デバッグ用: 実行したツール
          x_tools_used: result.toolsUsed,
        });
      }
    } catch (e) {
      log(ip, `[エージェントAPI] エラー: ${e.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: e.message, type: 'server_error' } });
      }
    }
  });

  // ヘルスチェック
  app.get('/health', (req, res) => res.json({ status: 'ok', mode: 'agent', model: modelName }));

  // 404: 全ての未知のパスを JSON で返す (Express デフォルトの HTML を抑制)
  app.use((req, res) => {
    res.status(404).json({
      error: {
        message: `エンドポイントが見つかりません: ${req.method} ${req.path}`,
        type: 'not_found',
        hint: 'OpenAI互換: POST /v1/chat/completions、GET /v1/models、GET /health',
      },
    });
  });

  // 汎用エラーハンドラー (HTMLを返さずJSONで応答)
  app.use((err, req, res, next) => {
    log('-', `[エージェントAPI] 未捕捉エラー: ${err.message}`);
    if (!res.headersSent) {
      res.status(err.status || 500).json({
        error: { message: err.message || 'Internal server error', type: err.type || 'server_error' },
      });
    }
  });

  // サーバー起動
  return new Promise((resolve, reject) => {
    let server;
    try {
      if (useHttps) {
        const creds = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
        server = https.createServer(creds, app);
      } else {
        server = http.createServer(app);
      }
      server.on('error', reject);
      server.listen(port, host, () => {
        resolve({
          server,
          close: () => new Promise(r => server.close(r)),
        });
      });
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * ツール定義を構築 (OpenAI function calling 形式)
 */
function buildToolDefs(enabledTools, appConfig, deps = {}) {
  const tools = [];

  if (enabledTools.includes('web_search')) {
    tools.push({
      type: 'function',
      function: {
        name: 'web_search',
        description: 'インターネットを検索して最新情報を取得する。最新ニュース、現在の出来事、リアルタイムデータ (株価/天気/価格等) が必要な時に使う。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '検索クエリ' } },
          required: ['query'],
        },
      },
    });
  }

  if (enabledTools.includes('file')) {
    tools.push({
      type: 'function',
      function: {
        name: 'list_files',
        description: 'サーバーの uploads フォルダにあるファイル一覧を取得する。',
        parameters: { type: 'object', properties: {} },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'read_file',
        description: 'サーバーの uploads フォルダのファイルを読む。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'ファイル名 (uploads配下、プレフィックス不要)' } },
          required: ['path'],
        },
      },
    });
  }

  if (enabledTools.includes('ml') && appConfig.ml?.enabled) {
    tools.push({
      type: 'function',
      function: {
        name: 'ml_list_datasets',
        description: '機械学習用データテーブル(DuckDB)の一覧を取得する。',
        parameters: { type: 'object', properties: {} },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'ml_describe_dataset',
        description: '指定テーブルのスキーマ(カラム名・型)を取得する。',
        parameters: {
          type: 'object',
          properties: { table: { type: 'string' } },
          required: ['table'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'ml_query_dataset',
        description: '読み取り専用SQL (SELECT/WITH) を実行する。書き込み禁止。',
        parameters: {
          type: 'object',
          properties: {
            sql: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['sql'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'ml_list_models',
        description: '学習済みMLモデル一覧と性能指標、predictHint (正しい入力例) を取得する。',
        parameters: { type: 'object', properties: {} },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'ml_predict',
        description: '学習済みモデルで予測。features はモデルの元の特徴量名で渡す。日時列は "2027-04-15" のような文字列で渡せば自動分解される。',
        parameters: {
          type: 'object',
          properties: {
            modelName: { type: 'string' },
            features: { description: '辞書 or 辞書配列' },
          },
          required: ['modelName', 'features'],
        },
      },
    });
    // ─── 強化学習 (RL) ───
    tools.push({
      type: 'function',
      function: {
        name: 'rl_list_agents',
        description: '学習済み強化学習(RL)エージェントの一覧と性能指標を取得する。各エージェントはデータテーブルからオフライン学習されたもの (状態→推奨行動の方策)。',
        parameters: { type: 'object', properties: {} },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'rl_get_policy',
        description: 'RLエージェントに状態を与えて推奨行動とQ値を取得する。state は {列名: 値} の辞書で渡す (例: {"hour":22,"segment":"C"})。「この状況ではどの選択肢(行動)が最適?」に答えるツール。',
        parameters: {
          type: 'object',
          properties: {
            agentName: { type: 'string' },
            state: { description: '状態。{列名: 値} の辞書' },
          },
          required: ['agentName', 'state'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'rl_eval_agent',
        description: 'RLエージェントをオフライン方策評価する。ログ済み行動との一致率・推定価値(平均maxQ)・行動分布などを返す。',
        parameters: {
          type: 'object',
          properties: {
            agentName: { type: 'string' },
          },
          required: ['agentName'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'rl_train_agent',
        description: 'データテーブルからオフラインRLでエージェントの学習を開始する(非同期、jobIdを返す)。table・stateColumns・actionColumn・rewardColumn を指定。nextStateColumns を付ければ遷移ベースのオフラインRL、無ければ文脈付きバンディット。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'エージェント名 (英数字・ハイフン・アンダースコア)' },
            table: { type: 'string', description: '経験データのテーブル名' },
            stateColumns: { type: 'array', items: { type: 'string' }, description: '状態(特徴量)の列名配列' },
            actionColumn: { type: 'string', description: '行動の列名' },
            rewardColumn: { type: 'string', description: '報酬の列名' },
            nextStateColumns: { type: 'array', items: { type: 'string' }, description: '任意: 遷移先状態の列名配列 (stateColumnsと同数同順)' },
            doneColumn: { type: 'string', description: '任意: 終了フラグの列名' },
            algo: { type: 'string', description: 'アルゴリズム: dqn(既定) / ddqn / cql(保守的・オフライン向け) / bc(ログ模倣)' },
            episodes: { type: 'number', description: 'エポック数 (既定300)' },
          },
          required: ['name', 'table', 'stateColumns', 'actionColumn', 'rewardColumn'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'rl_act',
        description: 'オンラインRLエージェントに状態を与えて推奨行動を取得する。epsilon>0 を渡すと ε-greedy 探索 (学習用)。rl_get_policy と違いリアルタイム学習中のエージェント向け。',
        parameters: {
          type: 'object',
          properties: {
            agentName: { type: 'string' },
            state: { description: '状態。{列名: 値} の辞書' },
            epsilon: { type: 'number', description: '任意: 探索率 0〜1 (既定0=貪欲)' },
          },
          required: ['agentName', 'state'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'rl_learn',
        description: 'オンラインRLエージェントに経験(state, action, reward)を送り、その場で1ステップ学習させる。next_state/done は任意(遷移ベース時)。',
        parameters: {
          type: 'object',
          properties: {
            agentName: { type: 'string' },
            state: { description: '状態。{列名: 値} の辞書' },
            action: { type: 'string', description: '取った行動 (エージェントの行動集合内)' },
            reward: { type: 'number', description: '得られた報酬' },
            next_state: { description: '任意: 遷移先状態 {列名: 値}' },
            done: { description: '任意: エピソード終了フラグ' },
          },
          required: ['agentName', 'state', 'action', 'reward'],
        },
      },
    });
  }

  // ─── Google Drive ───
  // 接続済みのときだけツールを出す (未接続だと LLM がエラーを踏んでターンを浪費するため)
  if (enabledTools.includes('gdrive') && deps.gdrive) {
    const st = (() => { try { return deps.gdrive.status(); } catch { return { enabled: false, connected: false }; } })();
    if (st.enabled && st.connected) {
      tools.push({
        type: 'function',
        function: {
          name: 'gdrive_search_files',
          description: 'Google Drive 上のファイルを、ファイル名と本文の全文検索で探す。「ドライブの〜という資料」「Google Drive にある〜」のような依頼で最初に使う。返ってきた id を gdrive_read_file に渡して中身を読む。',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: '検索キーワード (ファイル名の一部、または本文に含まれる語)' },
              folderId: { type: 'string', description: '任意: 特定フォルダに絞る場合のフォルダIDまたはフォルダ名' },
              pageSize: { type: 'number', description: '任意: 最大件数 (既定20)' },
            },
            required: ['query'],
          },
        },
      });
      tools.push({
        type: 'function',
        function: {
          name: 'gdrive_list_files',
          description: 'Google Drive のフォルダの中身を一覧する。folderId を省略するとマイドライブ直下 (rootFolderId 設定時はその配下)。folderId にはIDのほか "資料/2026年度" のようなフォルダパスも指定できる。',
          parameters: {
            type: 'object',
            properties: {
              folderId: { type: 'string', description: '任意: フォルダIDまたはフォルダ名/パス' },
              query: { type: 'string', description: '任意: このフォルダ内で名前を絞り込むキーワード' },
              pageSize: { type: 'number', description: '任意: 最大件数 (既定30)' },
            },
          },
        },
      });
      tools.push({
        type: 'function',
        function: {
          name: 'gdrive_read_file',
          description: 'Google Drive のファイルの中身をテキストで読む。Google ドキュメントはテキスト、スプレッドシートはCSVに自動変換される。fileId には gdrive_search_files / gdrive_list_files で得た id を渡すこと (ファイル名でも可)。PDFや画像などのバイナリは読めないので gdrive_import_to_server を使う。',
          parameters: {
            type: 'object',
            properties: {
              fileId: { type: 'string', description: 'ファイルID (推奨) またはファイル名' },
              maxChars: { type: 'number', description: '任意: 取得する最大文字数' },
            },
            required: ['fileId'],
          },
        },
      });
      tools.push({
        type: 'function',
        function: {
          name: 'gdrive_import_to_server',
          description: 'Google Drive のファイルをサーバーの uploads フォルダに取り込む。PDF・画像・Excel等そのままでは読めないファイルや、後で処理したいデータに使う。取り込み後は read_file で参照できる。',
          parameters: {
            type: 'object',
            properties: {
              fileId: { type: 'string', description: 'ファイルID (推奨) またはファイル名' },
              savePath: { type: 'string', description: '任意: uploads 配下の保存先相対パス (省略時は Drive 上の名前)' },
            },
            required: ['fileId'],
          },
        },
      });

      if (st.allowWrite) {
        tools.push({
          type: 'function',
          function: {
            name: 'gdrive_write_file',
            description: 'Google Drive にテキストファイルを作成または更新する。fileId を指定すると更新、指定しなければ folderId の中に name で新規作成する。',
            parameters: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'ファイル名 (新規作成時は必須。拡張子を付けるとMIMEが決まる)' },
                content: { type: 'string', description: 'ファイルの内容 (テキスト)' },
                folderId: { type: 'string', description: '任意: 作成先フォルダIDまたはフォルダ名/パス' },
                fileId: { type: 'string', description: '任意: 更新したい既存ファイルのID' },
                overwrite: { type: 'boolean', description: '任意: 同名ファイルがあれば上書きする (既定false)' },
              },
              required: ['content'],
            },
          },
        });
        tools.push({
          type: 'function',
          function: {
            name: 'gdrive_upload_from_server',
            description: 'サーバーの uploads フォルダにあるファイルを Google Drive にアップロードする。バイナリも可。',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'uploads 配下の相対パス (例: "report.csv")' },
                name: { type: 'string', description: '任意: Drive 上でのファイル名 (省略時は元のファイル名)' },
                folderId: { type: 'string', description: '任意: アップロード先フォルダIDまたはフォルダ名/パス' },
              },
              required: ['path'],
            },
          },
        });
        tools.push({
          type: 'function',
          function: {
            name: 'gdrive_create_folder',
            description: 'Google Drive にフォルダを作成する。',
            parameters: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'フォルダ名' },
                folderId: { type: 'string', description: '任意: 親フォルダIDまたはフォルダ名/パス' },
              },
              required: ['name'],
            },
          },
        });
      }

      if (st.allowDelete) {
        tools.push({
          type: 'function',
          function: {
            name: 'gdrive_delete_file',
            description: 'Google Drive のファイルをゴミ箱に移動する。ユーザーが明確に削除を依頼した時だけ使うこと。',
            parameters: {
              type: 'object',
              properties: {
                fileId: { type: 'string', description: 'ファイルID (推奨) またはファイル名' },
              },
              required: ['fileId'],
            },
          },
        });
      }
    }
  }

  if (enabledTools.includes('rag')) {
    tools.push({
      type: 'function',
      function: {
        name: 'search_persistent_documents',
        description: 'サーバーに恒久的に登録済みのRAGドキュメントから、embedding ベクトル類似度で関連箇所を検索する。社内文書・マニュアル・ポリシー・FAQ等を参照するためのツール。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '検索したい内容・キーワード' } },
          required: ['query'],
        },
      },
    });
  }

  return tools;
}

/**
 * エージェントループ: ツール判断 → 実行 → 最終応答
 */
async function runAgentLoop({ messages, tools, temperature, maxTokens, chatHost, chatPort, modelName, deps, ip }) {
  const { log } = deps;
  const MAX_TURNS = 5;
  const apiMessages = [...messages];
  const toolsUsed = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // llama-server にツール付きで問い合わせ
    const llamaResp = await callLlama({
      chatHost, chatPort, modelName,
      messages: apiMessages,
      tools: tools.length > 0 ? tools : undefined,
      temperature, maxTokens,
      stream: false,
    });

    const choice = llamaResp.choices?.[0];
    const msg = choice?.message || {};
    if (llamaResp.usage) {
      totalPromptTokens += llamaResp.usage.prompt_tokens || 0;
      totalCompletionTokens += llamaResp.usage.completion_tokens || 0;
    }

    const toolCalls = msg.tool_calls || [];
    if (toolCalls.length === 0) {
      // ツール呼び出しなし = 最終応答
      return {
        content: (msg.content || '').trim(),
        toolsUsed,
        usage: {
          prompt_tokens: totalPromptTokens,
          completion_tokens: totalCompletionTokens,
          total_tokens: totalPromptTokens + totalCompletionTokens,
        },
      };
    }

    // assistant のツール呼び出しメッセージを履歴に追加
    apiMessages.push({ role: 'assistant', content: msg.content || '', tool_calls: toolCalls });

    // 各ツールを実行
    for (const tc of toolCalls) {
      const fnName = tc.function?.name;
      let fnArgs = {};
      try { fnArgs = JSON.parse(tc.function?.arguments || '{}'); } catch {}
      log(ip, `[エージェントAPI] tool: ${fnName}(${JSON.stringify(fnArgs).slice(0, 100)})`);
      toolsUsed.push(fnName);

      let toolResult;
      try {
        toolResult = await executeTool(fnName, fnArgs, deps, ip);
      } catch (e) {
        toolResult = `エラー: ${e.message}`;
      }
      let content = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2);
      if (content.length > 50000) content = content.slice(0, 50000) + '\n... (省略)';

      apiMessages.push({ role: 'tool', tool_call_id: tc.id, content });
    }
  }

  // MAX_TURNS 到達: ツールなしで最終応答を強制
  const finalResp = await callLlama({
    chatHost, chatPort, modelName,
    messages: apiMessages,
    temperature, maxTokens,
    stream: false,
  });
  const finalMsg = finalResp.choices?.[0]?.message || {};
  return {
    content: (finalMsg.content || '回答を生成できませんでした。').trim(),
    toolsUsed,
    usage: {
      prompt_tokens: totalPromptTokens,
      completion_tokens: totalCompletionTokens,
      total_tokens: totalPromptTokens + totalCompletionTokens,
    },
  };
}

/**
 * 個別ツールの実行
 */
async function executeTool(fnName, fnArgs, deps, ip) {
  const {
    ddgSearch, fetchPageText,
    getMlDb, loadMlModels, isValidTableName, isSafeReadOnlySql, ML_MODELS_DIR,
    runMlPredict,
    loadRlAgents, runRlPolicy, runRlEval, startRlTraining,
    rlOnlineAct, rlOnlineLearn,
    listUploadFiles, readUploadFile,
    searchDocumentsSimple,
    gdrive, gdriveImportToServer, gdriveUploadFromServer,
  } = deps;

  // Google Drive ツールの共通ガード
  const needGdrive = () => {
    if (!gdrive) throw new Error('Google Drive 連携が利用できません');
    return gdrive;
  };

  switch (fnName) {
    case 'web_search': {
      const results = await ddgSearch(fnArgs.query, 5);
      // 上位3件の本文取得
      const targets = results.slice(0, 3);
      await Promise.all(targets.map(async r => {
        try { r.body = await fetchPageText(r.url, 2000); } catch {}
      }));
      return { results };
    }

    case 'list_files':
      return await listUploadFiles();

    case 'read_file':
      return await readUploadFile(fnArgs.path);

    case 'ml_list_datasets': {
      const db = getMlDb();
      const rows = await db.allAsync(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='main'`
      );
      return { tables: rows.map(r => r.table_name) };
    }

    case 'ml_describe_dataset': {
      if (!isValidTableName(fnArgs.table)) throw new Error('無効なテーブル名');
      const db = getMlDb();
      const cols = await db.allAsync(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name=? ORDER BY ordinal_position`,
        fnArgs.table
      );
      return { table: fnArgs.table, columns: cols };
    }

    case 'ml_query_dataset': {
      if (!isSafeReadOnlySql(fnArgs.sql)) throw new Error('読み取り専用SQL (SELECT/WITH) のみ許可');
      let sql = fnArgs.sql.trim().replace(/;+\s*$/, '');
      const limit = Math.min(fnArgs.limit || 1000, 10000);
      if (!/\blimit\b/i.test(sql)) sql += ` LIMIT ${limit}`;
      const db = getMlDb();
      const rows = await db.allAsync(sql);
      return { rows, count: rows.length };
    }

    case 'ml_list_models': {
      const models = loadMlModels();
      const fsLocal = require('fs');
      const pathLocal = require('path');
      const trained = models.filter(m => {
        return fsLocal.existsSync(pathLocal.join(ML_MODELS_DIR, m.name, 'model.pt'));
      }).map(m => {
        const info = { name: m.name, task: m.task, tableName: m.tableName, features: m.features, target: m.target };
        try {
          const cfgPath = pathLocal.join(ML_MODELS_DIR, m.name, 'config.json');
          if (fsLocal.existsSync(cfgPath)) {
            const cfg = JSON.parse(fsLocal.readFileSync(cfgPath, 'utf-8'));
            const origFeatures = cfg.originalFeatures || cfg.features || [];
            const dtCols = cfg.datetimeSourceCols || [];
            const example = {};
            for (const f of origFeatures) {
              if (dtCols.includes(f)) example[f] = '2027-04-15';
              else if (/region|area|city/i.test(f)) example[f] = 'Tokyo';
              else if (/product|item/i.test(f)) example[f] = 'ProductA';
              else if (/quantity|qty|count/i.test(f)) example[f] = 5;
              else example[f] = '(値)';
            }
            info.predictHint = { requiredFeatures: origFeatures, datetimeColumns: dtCols, exampleInput: example };
          }
          const mpath = pathLocal.join(ML_MODELS_DIR, m.name, 'metrics.json');
          if (fsLocal.existsSync(mpath)) {
            const mt = JSON.parse(fsLocal.readFileSync(mpath, 'utf-8'));
            info.metrics = { mae: mt.finalMAE, accuracy: mt.finalAccuracy, testLoss: mt.finalTestLoss };
          }
        } catch {}
        return info;
      });
      return { models: trained, count: trained.length };
    }

    case 'ml_predict': {
      // 派生列の自動復元
      const sanitize = (f) => {
        if (Array.isArray(f)) return f.map(sanitize);
        if (!f || typeof f !== 'object') return f;
        const out = { ...f };
        const dateCols = new Set();
        for (const k of Object.keys(out)) {
          const m = k.match(/^([a-zA-Z][a-zA-Z0-9]*)_(year|month|day|dayofweek|dayofyear|is_weekend)$/);
          if (m) dateCols.add(m[1]);
        }
        for (const dc of dateCols) {
          if (out[dc] === undefined) {
            const y = out[`${dc}_year`], mo = out[`${dc}_month`], d = out[`${dc}_day`];
            if (y && mo && d) out[dc] = `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
          }
          for (const suf of ['year','month','day','dayofweek','dayofyear','is_weekend']) delete out[`${dc}_${suf}`];
        }
        return out;
      };
      const features = sanitize(fnArgs.features);
      return await runMlPredict(fnArgs.modelName, features);
    }

    case 'rl_list_agents': {
      if (!loadRlAgents) return { error: 'RL機能は利用できません' };
      const agents = loadRlAgents().map(a => ({
        name: a.name, datasetMode: a.datasetMode,
        tableName: a.tableName, stateColumns: a.stateColumns, actionColumn: a.actionColumn,
        actionLabels: a.actionLabels,
        metrics: a.metrics ? {
          policyAgreement: a.metrics.policyAgreement,
          meanQ: a.metrics.meanQ, loggedMeanReward: a.metrics.loggedMeanReward,
        } : null,
      }));
      return { agents, count: agents.length };
    }

    case 'rl_get_policy': {
      if (!runRlPolicy) return { error: 'RL機能は利用できません' };
      return await runRlPolicy(fnArgs.agentName, fnArgs.state);
    }

    case 'rl_eval_agent': {
      if (!runRlEval) return { error: 'RL機能は利用できません' };
      const r = await runRlEval(fnArgs.agentName, fnArgs.episodes);
      // サンプルはトークンが嵩むので要約のみ返す
      return {
        datasetMode: r.datasetMode, nRows: r.nRows,
        policyAgreement: r.policyAgreement, meanQ: r.meanQ,
        loggedMeanReward: r.loggedMeanReward, rewardWhenFollowed: r.rewardWhenFollowed,
        policyActionDist: r.policyActionDist, loggedActionDist: r.loggedActionDist,
      };
    }

    case 'rl_train_agent': {
      if (!startRlTraining) return { error: 'RL機能は利用できません' };
      try {
        const out = await startRlTraining(fnArgs, ip);
        return { ok: true, jobId: out.jobId, note: '学習を開始しました。完了後 rl_list_agents で確認できます。' };
      } catch (e) {
        return { error: e.message };
      }
    }

    case 'rl_act': {
      if (!rlOnlineAct) return { error: 'オンラインRL機能は利用できません' };
      try {
        const r = await rlOnlineAct(fnArgs.agentName, fnArgs.state, fnArgs.epsilon);
        return { action: r.action, qValues: r.qValues, explored: r.explored, totalSteps: r.totalSteps };
      } catch (e) {
        return { error: e.message };
      }
    }

    case 'rl_learn': {
      if (!rlOnlineLearn) return { error: 'オンラインRL機能は利用できません' };
      try {
        const r = await rlOnlineLearn(fnArgs.agentName, {
          state: fnArgs.state, action: fnArgs.action, reward: fnArgs.reward,
          next_state: fnArgs.next_state, done: fnArgs.done,
        });
        return { ok: true, loss: r.loss, bufferSize: r.bufferSize, totalSteps: r.totalSteps, rewardEMA: r.rewardEMA, warnings: r.warnings };
      } catch (e) {
        return { error: e.message };
      }
    }

    // ─── Google Drive ───
    case 'gdrive_search_files': {
      const r = await needGdrive().searchFiles({
        query: fnArgs.query, folderId: fnArgs.folderId, pageSize: fnArgs.pageSize,
      });
      return { files: r.files, count: r.files.length };
    }

    case 'gdrive_list_files': {
      const r = await needGdrive().listFiles({
        folderId: fnArgs.folderId, query: fnArgs.query, pageSize: fnArgs.pageSize,
      });
      return { folderId: r.folderId, files: r.files, count: r.files.length };
    }

    case 'gdrive_read_file': {
      const id = fnArgs.fileId || fnArgs.id || fnArgs.name || fnArgs.file;
      return await needGdrive().readFileAsText(id, { maxChars: fnArgs.maxChars });
    }

    case 'gdrive_import_to_server': {
      if (!gdriveImportToServer) throw new Error('Google Drive の取り込みは利用できません');
      const id = fnArgs.fileId || fnArgs.id || fnArgs.name || fnArgs.file;
      return await gdriveImportToServer(id, fnArgs.savePath, fnArgs.preferOffice);
    }

    case 'gdrive_write_file': {
      return await needGdrive().uploadFile({
        name: fnArgs.name,
        content: fnArgs.content,
        folderId: fnArgs.folderId,
        fileId: fnArgs.fileId,
        overwrite: !!fnArgs.overwrite,
        mimeType: fnArgs.mimeType,
      });
    }

    case 'gdrive_upload_from_server': {
      if (!gdriveUploadFromServer) throw new Error('Google Drive へのアップロードは利用できません');
      return await gdriveUploadFromServer(fnArgs.path, {
        name: fnArgs.name, folderId: fnArgs.folderId, overwrite: fnArgs.overwrite,
      });
    }

    case 'gdrive_create_folder': {
      return await needGdrive().createFolder({ name: fnArgs.name, folderId: fnArgs.folderId });
    }

    case 'gdrive_delete_file': {
      const id = fnArgs.fileId || fnArgs.id || fnArgs.name || fnArgs.file;
      return await needGdrive().deleteFile(id, { permanent: false });
    }

    // 新名 + 後方互換 (search_documents) の両方を受ける
    case 'search_persistent_documents':
    case 'search_documents': {
      if (searchDocumentsSimple) return await searchDocumentsSimple(fnArgs.query);
      return { error: 'ドキュメント検索は利用できません (サーバーにアップロード済みドキュメントが必要)' };
    }

    default:
      throw new Error(`未知のツール: ${fnName}`);
  }
}

/**
 * 内部 llama-server を呼ぶ
 */
async function callLlama({ chatHost, chatPort, modelName, messages, tools, temperature, maxTokens, stream }) {
  const useHttps = false;  // 内部通信は常にHTTP (localhost)
  const url = `http://${chatHost}:${chatPort}/v1/chat/completions`;
  const payload = {
    model: modelName,
    messages,
    stream: false,
  };
  if (tools) payload.tools = tools;
  if (temperature !== undefined) payload.temperature = temperature;
  if (maxTokens !== undefined) payload.max_tokens = maxTokens;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`llama-server エラー (${resp.status}): ${text.slice(0, 200)}`);
  }
  return await resp.json();
}

module.exports = { startAgentServer };
