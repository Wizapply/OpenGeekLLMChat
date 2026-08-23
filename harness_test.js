/**
 * harness_test.js — エージェントハーネス (harness.js) のスモークテスト
 *
 * 依存パッケージ・LLM 不要 (chat をモックして検証する)。
 * 使い方:  node harness_test.js
 * 全テストが PASS なら exit 0、失敗があれば exit 1。
 */

const {
  createHarness,
  neutralHarnessConfig,
  HARNESS_VERSION,
  matchToolPattern,
  estimateTokensFromText,
  estimateTokensFromMessages,
} = require('./harness');

// ─── テストヘルパー ───
let passed = 0, failed = 0;
function check(cond, name, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(title) { console.log(`\n── ${title} ──`); }

const respMsg = (message) => ({
  choices: [{ message }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});
const tc = (name, args, id = 'call-1') => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
});

// script: [(payload) => response, ...] を順に消費。summary は共通処理
function mockChat(script, { onCall } = {}) {
  const calls = [];
  const fn = async (payload) => {
    calls.push(payload);
    if (onCall) onCall(payload);
    if (payload.purpose === 'summary') return respMsg({ content: '・要約テスト (自動圧縮済み)' });
    const next = script.shift();
    if (!next) throw new Error('mockChat: スクリプトが尽きました');
    return typeof next === 'function' ? next(payload) : next;
  };
  fn.calls = calls;
  return fn;
}

const READ_TOOL = {
  name: 'web_search', description: 'Web検索',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  readOnly: true, untrustedOutput: true, fastDirect: true,
  hintKeywords: ['天気', 'ニュース'],
};
const WRITE_TOOL = {
  name: 'gdrive_write_file', description: 'Driveへ書き込み',
  parameters: { type: 'object', properties: { content: { type: 'string' } } },
  readOnly: false,
};
const DANGER_TOOL = {
  name: 'gdrive_delete_file', description: 'Drive削除',
  parameters: { type: 'object', properties: { fileId: { type: 'string' } } },
  readOnly: false, dangerous: true,
};

async function main() {
  // ═══ 1. 基本ループ: ツール判断 → 実行 → 最終応答 ═══
  section('1. 基本エージェントループ');
  {
    const chat = mockChat([
      () => respMsg({ content: '', tool_calls: [tc('web_search', { query: 'test' })] }),
      () => respMsg({ content: '最終回答です' }),
    ]);
    const executed = [];
    const h = createHarness({ config: { llmRetries: 0 }, chat });
    h.registerTool({ ...READ_TOOL, execute: async (a) => { executed.push(a); return { results: ['r1'] }; } });
    const r = await h.run({ messages: [{ role: 'user', content: 'テスト' }] });
    check(r.content === '最終回答です', '最終応答が返る');
    check(r.toolsUsed.length === 1 && r.toolsUsed[0] === 'web_search', 'ツールが1回実行される');
    check(executed[0]?.query === 'test', '引数が渡る');
    check(r.usage.total_tokens === 30, 'usage が集計される (2呼び出し分)');
    check(r.harness.version === HARNESS_VERSION, 'x_harness にバージョンが入る');
    const toolMsg = chat.calls[1].messages.find(m => m.role === 'tool');
    check(!!toolMsg && toolMsg.content.includes('<system-reminder>'), '外部データ注意リマインダーが付く');
  }

  // ═══ 2. 権限モード: plan ═══
  section('2. 権限モード plan (読み取り専用のみ)');
  {
    const chat = mockChat([
      // 広告されていなくても LLM が書き込みツールを呼んだと仮定 → 拒否されるはず
      () => respMsg({ content: '', tool_calls: [tc('gdrive_write_file', { content: 'x' })] }),
      () => respMsg({ content: '計画を提示します' }),
    ]);
    let wrote = false;
    const h = createHarness({ config: { permissionMode: 'plan', llmRetries: 0 }, chat });
    h.registerTool({ ...READ_TOOL, execute: async () => ({}) });
    h.registerTool({ ...WRITE_TOOL, execute: async () => { wrote = true; return {}; } });
    const defs = h.getToolDefs().map(d => d.function.name);
    check(defs.includes('web_search') && !defs.includes('gdrive_write_file'),
      'plan では書き込みツールを LLM に見せない', JSON.stringify(defs));
    const r = await h.run({ messages: [{ role: 'user', content: 'ファイルを作って' }] });
    check(!wrote, '書き込みツールは実行されない');
    check(r.deniedTools.includes('gdrive_write_file'), 'deniedTools に記録される');
    const sysReminder = chat.calls[0].messages.find(m => typeof m.content === 'string' && m.content.includes('計画モード'));
    check(!!sysReminder, '計画モードのリマインダーが注入される');
  }

  // ═══ 3. 権限モード: default + allowedTools (glob) ═══
  section('3. 権限モード default + allowedTools');
  {
    const chat = mockChat([
      () => respMsg({ content: '', tool_calls: [tc('gdrive_write_file', { content: 'x' })] }),
      () => respMsg({ content: 'OK' }),
    ]);
    let wrote = false;
    const h = createHarness({ config: { permissionMode: 'default', allowedTools: ['gdrive_*'], llmRetries: 0 }, chat });
    h.registerTool({ ...WRITE_TOOL, execute: async () => { wrote = true; return { ok: true }; } });
    await h.run({ messages: [{ role: 'user', content: '書いて' }] });
    check(wrote, 'allowedTools の glob 一致で書き込みツールが実行される');

    // 許可リストなし + 確認手段なし → 見せない & 拒否
    const h2 = createHarness({ config: { permissionMode: 'default', llmRetries: 0 }, chat: mockChat([]) });
    h2.registerTool({ ...WRITE_TOOL, execute: async () => ({}) });
    check(h2.getToolDefs().length === 0, '許可リスト外の書き込みツールは見せない');
    check(h2.decidePermission('gdrive_write_file').decision === 'ask', '判定は ask (確認手段があれば聞く)');
  }

  // ═══ 4. acceptEdits と disallowedTools ═══
  section('4. acceptEdits / disallowedTools');
  {
    const h = createHarness({ config: { permissionMode: 'acceptEdits', llmRetries: 0 }, chat: mockChat([]) });
    h.registerTool({ ...WRITE_TOOL, execute: async () => ({}) });
    h.registerTool({ ...DANGER_TOOL, execute: async () => ({}) });
    check(h.decidePermission('gdrive_write_file').decision === 'allow', 'acceptEdits: 書き込みは許可');
    check(h.decidePermission('gdrive_delete_file').decision === 'deny', 'acceptEdits: 破壊的ツールは拒否');

    const h2 = createHarness({
      config: { permissionMode: 'bypassPermissions', disallowedTools: ['web_*'], llmRetries: 0 },
      chat: mockChat([]),
    });
    h2.registerTool({ ...READ_TOOL, execute: async () => ({}) });
    check(h2.decidePermission('web_search').decision === 'deny', 'disallowedTools は bypass より優先');
    check(h2.getToolDefs().length === 0, '禁止ツールは LLM に見せない');
  }

  // ═══ 5. リピートガード ═══
  section('5. リピートガード (同一ツール+同一引数)');
  {
    const same = { query: '同じ' };
    const chat = mockChat([
      () => respMsg({ content: '', tool_calls: [tc('web_search', same, 'a')] }),
      () => respMsg({ content: '', tool_calls: [tc('web_search', same, 'b')] }),
      () => respMsg({ content: '打ち切って回答' }),
    ]);
    let execCount = 0;
    const h = createHarness({ config: { repeatGuard: 2, llmRetries: 0 }, chat });
    h.registerTool({ ...READ_TOOL, execute: async () => { execCount++; return {}; } });
    const r = await h.run({ messages: [{ role: 'user', content: 'x' }] });
    check(execCount === 1, '2回目の同一呼び出しは実行されない');
    check(r.harness.repeatBlocked === 1, 'repeatBlocked が記録される');
    const blocked = chat.calls[2].messages.filter(m => m.role === 'tool').some(m => m.content.includes('繰り返し'));
    check(blocked, 'ブロック理由がツール結果として LLM に伝わる');
  }

  // ═══ 6. System-1 即決 (fastRouting) ═══
  section('6. System-1 即決ルール');
  {
    // 6a: キーワード不一致 → 判断LLMを飛ばして直接最終応答 (chat 1回のみ)
    const chat = mockChat([() => respMsg({ content: '直接回答' })]);
    const h = createHarness({ config: { fastRouting: true, llmRetries: 0 }, chat });
    h.registerTool({ ...READ_TOOL, execute: async () => ({}) });
    const r = await h.run({ messages: [{ role: 'user', content: 'こんにちは、元気？' }] });
    check(chat.calls.length === 1 && chat.calls[0].purpose === 'final', 'ツール不要が明白 → 判断LLM省略');
    check(r.harness.rulesFired[0] === 'skip_tools:', 'rulesFired に記録される');

    // 6b: 1ツールが明白 → 判断LLM抜きで即実行 → 最終応答
    const chat2 = mockChat([() => respMsg({ content: '天気の回答' })]);
    let q = null;
    const h2 = createHarness({ config: { fastRouting: true, llmRetries: 0 }, chat: chat2 });
    h2.registerTool({ ...READ_TOOL, execute: async (a) => { q = a.query; return { results: [] }; } });
    const r2 = await h2.run({ messages: [{ role: 'user', content: '今日の東京の天気は？' }] });
    check(q === '今日の東京の天気は？', '質問文そのままで即実行される');
    check(chat2.calls.length === 1, '判断LLMを1回も呼ばない');
    check(r2.harness.rulesFired[0] === 'force_tool:web_search', 'force_tool が記録される');
    check(r2.toolsUsed.includes('web_search'), 'toolsUsed に入る');

    // 6c: customRules は fastRouting=false でも効く
    const chat3 = mockChat([() => respMsg({ content: '規則で直答' })]);
    const h3 = createHarness({
      config: { fastRouting: false, customRules: [{ pattern: '^社内規則', action: 'skip_tools' }], llmRetries: 0 },
      chat: chat3,
    });
    h3.registerTool({ ...READ_TOOL, execute: async () => ({}) });
    const r3 = await h3.run({ messages: [{ role: 'user', content: '社内規則を教えて' }] });
    check(chat3.calls.length === 1 && r3.harness.rulesFired.length === 1, 'customRules 単独で発火する');
  }

  // ═══ 7. フック ═══
  section('7. フック (PreToolUse / PostToolUse / UserPromptSubmit)');
  {
    // 7a: JS フックで引数書き換え + PostToolUse で追加コンテキスト
    const chat = mockChat([
      () => respMsg({ content: '', tool_calls: [tc('web_search', { query: '元のクエリ' })] }),
      () => respMsg({ content: 'ok' }),
    ]);
    let got = null;
    const h = createHarness({ config: { llmRetries: 0 }, chat });
    h.registerTool({ ...READ_TOOL, execute: async (a) => { got = a.query; return 'result'; } });
    h.on('PreToolUse', ({ args }) => ({ updatedArgs: { ...args, query: '書き換え後' } }));
    h.on('PostToolUse', () => ({ additionalContext: '結果は社外秘として扱うこと' }));
    await h.run({ messages: [{ role: 'user', content: 'x' }] });
    check(got === '書き換え後', 'PreToolUse フックで引数を書き換えられる');
    const toolMsg = chat.calls[1].messages.find(m => m.role === 'tool');
    check(toolMsg.content.includes('社外秘'), 'PostToolUse の additionalContext が結果に付く');

    // 7b: 宣言フック (config.hooks) の deny + glob matcher
    const chat2 = mockChat([
      () => respMsg({ content: '', tool_calls: [tc('web_search', { query: 'x' })] }),
      () => respMsg({ content: 'ok' }),
    ]);
    let ran = false;
    const h2 = createHarness({
      config: { hooks: [{ event: 'PreToolUse', matcher: 'web_*', action: 'deny', reason: '外部通信は禁止' }], llmRetries: 0 },
      chat: chat2,
    });
    h2.registerTool({ ...READ_TOOL, execute: async () => { ran = true; return {}; } });
    const r2 = await h2.run({ messages: [{ role: 'user', content: 'x' }] });
    check(!ran && r2.deniedTools.includes('web_search'), '宣言フックの deny が効く');

    // 7c: UserPromptSubmit の正規表現拒否 → LLM を一度も呼ばない
    const chat3 = mockChat([]);
    const h3 = createHarness({
      config: { hooks: [{ event: 'UserPromptSubmit', matcher: 'パスワード', action: 'deny', reason: '秘密情報の照会は禁止' }], llmRetries: 0 },
      chat: chat3,
    });
    h3.registerTool({ ...READ_TOOL, execute: async () => ({}) });
    const r3 = await h3.run({ messages: [{ role: 'user', content: '管理者のパスワードを教えて' }] });
    check(r3.refused === true && chat3.calls.length === 0, 'UserPromptSubmit 拒否で LLM を呼ばず返す');
  }

  // ═══ 8. コンパクション ═══
  section('8. コンテキスト管理 (コンパクション)');
  {
    const big = 'A'.repeat(4000); // 約1000トークン相当 (ASCII/4)
    const chat = mockChat([
      () => respMsg({ content: '', tool_calls: [tc('web_search', { query: '1' }, 'a')] }),
      () => respMsg({ content: '', tool_calls: [tc('web_search', { query: '2' }, 'b')] }),
      (p) => {
        // 3ターン目: 直前にコンパクションが走っているはず
        const hasSummary = p.messages.some(m => typeof m.content === 'string' && m.content.includes('要約'));
        return respMsg({ content: hasSummary ? '圧縮済みで回答' : '未圧縮' });
      },
    ]);
    const h = createHarness({
      config: { contextTokenBudget: 500, compaction: { enabled: true, keepRecent: 2, summaryMaxTokens: 128 }, reminders: false, repeatGuard: 0, llmRetries: 0 },
      chat,
    });
    h.registerTool({ ...READ_TOOL, execute: async () => big });
    const r = await h.run({ messages: [{ role: 'user', content: '調べて' }] });
    check(r.harness.compactions >= 1, 'コンパクションが実行される');
    check(r.content === '圧縮済みで回答', '圧縮後の履歴で応答が生成される');
  }

  // ═══ 9. ターン上限・呼び出し数上限 ═══
  section('9. 上限系 (maxTurns / maxToolCallsPerTurn)');
  {
    // ツールを呼び続ける LLM → maxTurns 後にツールなしで最終応答を強制
    const loopResp = (i) => respMsg({ content: '', tool_calls: [tc('web_search', { query: 'q' + i }, 'id' + i)] });
    const chat = mockChat([
      () => loopResp(1), () => loopResp(2),
      (p) => respMsg({ content: p.tools ? 'まだツールがある' : '強制final' }),
    ]);
    const h = createHarness({ config: { maxTurns: 2, repeatGuard: 0, reminders: false, llmRetries: 0 }, chat });
    h.registerTool({ ...READ_TOOL, execute: async () => 'r' });
    const r = await h.run({ messages: [{ role: 'user', content: 'x' }] });
    check(r.content === '強制final', 'maxTurns 到達後はツールなしで最終応答');
    check(r.turns === 2, 'turns が記録される');

    // 1ターンの呼び出し数上限
    const many = respMsg({ content: '', tool_calls: [tc('web_search', { query: '1' }, 'a'), tc('web_search', { query: '2' }, 'b'), tc('web_search', { query: '3' }, 'c')] });
    const chat2 = mockChat([() => many, () => respMsg({ content: 'ok' })]);
    let count = 0;
    const h2 = createHarness({ config: { maxToolCallsPerTurn: 2, repeatGuard: 0, llmRetries: 0 }, chat: chat2 });
    h2.registerTool({ ...READ_TOOL, execute: async () => { count++; return 'r'; } });
    const r2 = await h2.run({ messages: [{ role: 'user', content: 'x' }] });
    check(count === 2, '上限を超えた分は実行されない');
    check(chat2.calls[1].messages.filter(m => m.role === 'tool').length === 3, '超過分にも拒否結果を返す (tool_call_id の対応維持)');
    check(r2.deniedTools.length === 1, '超過分は deniedTools に入る');
  }

  // ═══ 10. リトライと素通し設定 ═══
  section('10. 救済リトライ / neutralHarnessConfig');
  {
    let attempt = 0;
    const flaky = async (p) => {
      if (p.purpose === 'summary') return respMsg({ content: 's' });
      attempt++;
      if (attempt === 1) throw new Error('一時的な接続断');
      return respMsg({ content: '復帰しました' });
    };
    const h = createHarness({ config: { llmRetries: 1, llmRetryDelayMs: 1 }, chat: flaky });
    h.registerTool({ ...READ_TOOL, execute: async () => ({}) });
    const r = await h.run({ messages: [{ role: 'user', content: 'x' }] });
    check(r.content === '復帰しました', 'LLM 呼び出し失敗を再試行で救済する');

    const n = neutralHarnessConfig();
    check(n.permissionMode === 'bypassPermissions' && n.fastRouting === false && n.reminders === false
      && n.repeatGuard === 0 && n.contextTokenBudget === 0 && n.compaction.enabled === false,
      'neutralHarnessConfig は従来ループ相当の素通し設定');
  }

  // ═══ 11. ユーティリティ ═══
  section('11. ユーティリティ (glob / トークン見積もり)');
  {
    check(matchToolPattern('gdrive_*', 'gdrive_write_file'), 'glob 前方一致');
    check(!matchToolPattern('gdrive_*', 'web_search'), 'glob 不一致');
    check(matchToolPattern('*', 'anything'), '* は全一致');
    check(matchToolPattern('web_search', 'web_search') && !matchToolPattern('web', 'web_search'), '完全一致のみ (部分一致しない)');
    check(estimateTokensFromText('日本語テキスト') === 7, 'CJK は 1文字≒1トークン');
    check(estimateTokensFromText('abcdefgh') === 2, 'ASCII は 4文字≒1トークン');
    const est = estimateTokensFromMessages([{ role: 'user', content: 'テスト' }]);
    check(est > 3 && est < 20, 'メッセージ見積もりが妥当な範囲');
  }

  // ═══ 12. ブラウザ側ゲート (public/js/harness_client.js) ═══
  // 通常チャット (index.jsx) が使うクライアント実装が、サーバー側と同じ判定になるか
  section('12. harness_client.js (通常チャットのゲート)');
  {
    const HC = require('./public/js/harness_client.js');

    // 権限判定のマッピング (サーバー側 decidePermission と同一規則)
    check(HC.decidePermission({ permissionMode: 'plan' }, 'web_search').decision === 'allow', 'plan: 読み取り専用は許可');
    check(HC.decidePermission({ permissionMode: 'plan' }, 'write_file').decision === 'deny', 'plan: 書き込みは拒否');
    check(HC.decidePermission({ permissionMode: 'default', allowedTools: ['gdrive_*'] }, 'gdrive_write_file').decision === 'allow', 'default: allowedTools の glob 一致');
    check(HC.decidePermission({ permissionMode: 'default' }, 'write_file').decision === 'ask', 'default: 許可リスト外は ask (confirm対象)');
    check(HC.decidePermission({ permissionMode: 'acceptEdits' }, 'gdrive_delete_file').decision === 'deny', 'acceptEdits: 破壊的ツールは拒否');
    check(HC.decidePermission({ permissionMode: 'bypassPermissions', disallowedTools: ['web_*'] }, 'web_search').decision === 'deny', 'disallowedTools は bypass より優先');

    // ツール定義の事前フィルタ (deny のみ除外、ask は confirm できるので残す)
    const defs = [
      { type: 'function', function: { name: 'web_search' } },
      { type: 'function', function: { name: 'write_file' } },
      { type: 'function', function: { name: 'gdrive_delete_file' } },
    ];
    const removed = HC.filterToolDefsInPlace({ enabled: true, permissionMode: 'plan' }, defs);
    check(defs.length === 1 && defs[0].function.name === 'web_search', 'plan: 書き込み系を定義から除外');
    check(removed.includes('write_file') && removed.includes('gdrive_delete_file'), '除外リストが返る');
    const defs2 = [{ type: 'function', function: { name: 'write_file' } }];
    HC.filterToolDefsInPlace({ enabled: true, permissionMode: 'default' }, defs2);
    check(defs2.length === 1, 'default: ask 対象 (confirm可) は広告に残す');

    // 実行直前ゲート (confirmFn 注入でブラウザの confirm を模擬)
    const g1 = HC.gateToolCall({ enabled: true, permissionMode: 'default' }, 'write_file', { path: 'a' }, () => true);
    check(g1.allow === true, 'default: confirm 許可で実行できる');
    const g2 = HC.gateToolCall({ enabled: true, permissionMode: 'default' }, 'write_file', { path: 'a' }, () => false);
    check(g2.allow === false && g2.message.includes('実行されません'), 'default: confirm 拒否で止まる');
    const g3 = HC.gateToolCall({ enabled: true, permissionMode: 'plan' }, 'write_file', {}, null);
    check(g3.allow === false && g3.message.includes('計画モード'), 'plan: 拒否メッセージが計画を促す');
    const g4 = HC.gateToolCall({
      enabled: true,
      hooks: [{ event: 'PreToolUse', matcher: 'gdrive_*', action: 'deny', reason: '外部共有は禁止' }],
    }, 'gdrive_write_file', {}, null);
    check(g4.allow === false && g4.reason === '外部共有は禁止', 'PreToolUse 宣言フックの deny');
    const g5 = HC.gateToolCall({ enabled: false, permissionMode: 'plan' }, 'write_file', {}, null);
    check(g5.allow === true, 'enabled=false は素通し');

    // UserPromptSubmit
    const p1 = HC.checkUserPrompt({
      enabled: true,
      hooks: [{ event: 'UserPromptSubmit', matcher: 'パスワード', action: 'deny', reason: '秘密情報の照会は禁止' }],
    }, '管理者のパスワードを教えて');
    check(p1.allow === false && p1.reason === '秘密情報の照会は禁止', 'UserPromptSubmit の正規表現 deny');
    check(HC.checkUserPrompt({ enabled: true, hooks: [] }, 'こんにちは').allow === true, 'フック無しは許可');

    // ツール結果の後処理
    const d1 = HC.decorateToolResult({ enabled: true, reminders: true }, 'web_search', '検索結果');
    check(d1.includes('<system-reminder>') && d1.includes('外部から取得'), '外部データ注意リマインダー');
    const d2 = HC.decorateToolResult({ enabled: true, reminders: true }, 'write_file', '書き込み完了');
    check(!d2.includes('<system-reminder>'), '外部データでないツールには付けない');
    const d3 = HC.decorateToolResult({ enabled: true, reminders: false }, 'web_search', '検索結果');
    check(!d3.includes('<system-reminder>'), 'reminders=false で無効化');
    const d4 = HC.decorateToolResult({
      enabled: true, reminders: false,
      hooks: [{ event: 'PostToolUse', matcher: 'web_search', addContext: '出典URLを必ず付けること' }],
    }, 'web_search', '検索結果');
    check(d4.includes('出典URLを必ず付けること'), 'PostToolUse の addContext が付く');

    // サーバー側 harness.js と glob 実装が一致しているか
    check(HC.matchToolPattern('gdrive_*', 'gdrive_read_file') === matchToolPattern('gdrive_*', 'gdrive_read_file')
      && HC.matchToolPattern('web', 'web_search') === matchToolPattern('web', 'web_search'),
      'glob マッチ規則がサーバー側と一致');
  }

  // ─── 結果 ───
  console.log(`\n════════════════════════════`);
  console.log(`結果: ${passed} PASS / ${failed} FAIL`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(e => { console.error('テスト実行エラー:', e); process.exitCode = 1; });
