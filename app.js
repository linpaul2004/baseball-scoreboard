(() => {
  const STORAGE_KEY = 'ballpark-scoreboard-v1';
  const positions = [
    ['P', '投手'], ['C', '捕手'], ['1B', '一壘手'], ['2B', '二壘手'], ['3B', '三壘手'],
    ['SS', '游擊手'], ['LF', '左外野手'], ['CF', '中外野手'], ['RF', '右外野手'], ['DH', '指定打擊']
  ];
  const lineupPositions = positions.filter(([code]) => code !== 'P');
  const bases = ['一壘', '二壘', '三壘'];
  const playLabels = {
    'swinging-strike': '揮棒落空，好球', 'called-strike': '好球未揮棒', ball: '壞球',
    'foul-tip': '擦棒被捕，好球', 'uncaught-third-strike': '不死三振，打者上一壘',
    hbp: '觸身球，打者上一壘', foul: '界外球', out: '接殺出局',
    single: '一壘安打', double: '二壘安打', triple: '三壘安打',
    'home-run': '全壘打', error: '守備失誤，打者上一壘', 'fielder-choice': '野手選擇',
    'intentional-walk': '故意四壞',
    'timeout-ball': '超時壞球', 'timeout-strike': '超時好球',
    sacrifice: '犧牲打', 'force-out': '封殺出局', pickoff: '牽制出局'
  };
  const $ = (selector) => document.querySelector(selector);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const makeLineup = (teamIndex) => {
    const roles = ['CF', 'SS', 'RF', '1B', 'DH', 'LF', '3B', 'C', '2B'];
    return roles.map((position, index) => ({
      id: `${teamIndex ? 'H' : 'A'}${index + 1}`, name: '', number: String(index + 1), position
    }));
  };
  const defaultState = () => ({
    teams: [
      { name: '客隊', innings: Array(9).fill(null), hits: 0, errors: 0, lineup: makeLineup(0), pitcher: { id: 'AP', name: '', number: '20', position: 'P' }, bench: [] },
      { name: '主隊', innings: Array(9).fill(null), hits: 0, errors: 0, lineup: makeLineup(1), pitcher: { id: 'HP', name: '', number: '18', position: 'P' }, bench: [] }
    ],
    gameInfo: '',
    inning: 1, half: 'top', gameOver: false, walkOff: false, balls: 0, strikes: 0, outs: 0,
    bases: [null, null, null], batter: '', batterOverride: false, batterNumber: 1, orderIndexes: [0, 0],
    pitcherCounts: {}, plateAppearances: {}
  });
  let state = defaultState();
  let records = [];
  let cursor = 0;
  let selectedInning = 0;
  let selectedHalf = 'top';
  let pendingHit = '';
  let pendingDestinations = {};
  let runnerEvent = 'steal';
  let substitutionMode = 'defense';
  let toastTimer;

  function activeTeamIndex(gameState = state) { return gameState.half === 'top' ? 0 : 1; }
  function fieldingTeamIndex(gameState = state) { return 1 - activeTeamIndex(gameState); }
  function activeBatter(gameState = state) {
    const teamIndex = activeTeamIndex(gameState);
    const lineup = gameState.teams[teamIndex].lineup;
    const order = gameState.orderIndexes?.[teamIndex] ?? 0;
    const player = lineup[order % lineup.length];
    return gameState.batterOverride ? { ...player, name: gameState.batter } : player;
  }
  function displayPlayerName(player) {
    return String(player?.name || '').trim() || player?.position || '球員';
  }
  function batterName(gameState = state) {
    return displayPlayerName(activeBatter(gameState));
  }
  function currentPitcher(gameState = state) {
    const team = gameState.teams[fieldingTeamIndex(gameState)];
    return team.pitcher || team.lineup.find((player) => player.position === 'P') || team.lineup[0];
  }
  function halfLabel(inning, half) { return `${inning}局${half === 'top' ? '上' : '下'}`; }
  function teamRuns(team) {
    return team.innings.reduce((sum, score) => sum + (score ?? 0), 0);
  }

  function migrateState(saved) {
    const migrated = clone(saved);
    const defaults = defaultState();
    migrated.teams = defaults.teams.map((team, index) => {
      const old = migrated.teams?.[index] || {};
      let lineup = old.lineup;
      if (!Array.isArray(lineup) || lineup.length !== 9) {
        const oldDefense = migrated.defenses?.[index] || {};
        lineup = defaults.teams[index].lineup.map((player) => ({
          ...player,
          name: oldDefense[positions.find(([, label]) => label === player.position)?.[1]] || player.name
        }));
      }
      const legacyPitcherSource = old.pitcher || lineup.find((player) => player.position === 'P') || {
        ...team.pitcher,
        name: migrated.defenses?.[index]?.投手 || team.pitcher.name
      };
      const legacyPitcher = { ...legacyPitcherSource, position: 'P' };
      if (legacyPitcher) {
        const battingPitcherIndex = lineup.findIndex((player) => player.id === legacyPitcher.id && player.position === 'P');
        if (battingPitcherIndex >= 0) lineup[battingPitcherIndex].position = 'DH';
      }
      return {
        ...team, ...old, name: old.name || team.name, innings: old.innings || team.innings,
        lineup, pitcher: legacyPitcher || team.pitcher, bench: old.bench || []
      };
    });
    migrated.gameInfo ??= defaults.gameInfo;
    migrated.pitcherCounts ||= {};
    migrated.plateAppearances ||= {};
    migrated.orderIndexes ||= [0, 0];
    migrated.inning ||= 1;
    migrated.half ||= 'top';
    migrated.gameOver ??= false;
    migrated.walkOff ??= false;
    migrated.balls ??= 0;
    migrated.strikes ??= 0;
    migrated.outs ??= 0;
    migrated.bases ||= [null, null, null];
    migrated.batterNumber ||= 1;
    migrated.batterOverride ??= false;
    migrated.orderIndexes = migrated.orderIndexes.map((index) => Number.isInteger(index) ? index % 9 : 0);
    return migrated;
  }

  function replay(allRecords, through = allRecords.length) {
    let replayed = defaultState();
    for (const record of allRecords.slice(0, through)) {
      if (!record || !record.state || typeof record.label !== 'string') throw new Error('比賽紀錄包含無效資料');
      replayed = migrateState(record.state);
    }
    return replayed;
  }
  function enrichRecordPeople(allRecords) {
    let previous = defaultState();
    return allRecords.map((record) => {
      const batter = activeBatter(previous);
      const pitcher = currentPitcher(previous);
      const enriched = {
        ...record,
        batter: record.batter || (batter ? { ...batter } : null),
        pitcher: record.pitcher || (pitcher ? { ...pitcher } : null),
        state: migrateState(record.state)
      };
      previous = enriched.state;
      return enriched;
    });
  }

  function readSavedGame() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const data = JSON.parse(saved);
      if (!Array.isArray(data.records) || !Number.isInteger(data.cursor)) throw new Error('存檔資料格式不正確');
      records = enrichRecordPeople(data.records);
      cursor = Math.max(0, Math.min(data.cursor, records.length));
      state = cursor ? replay(records, cursor) : defaultState();
    } catch (error) {
      console.error('無法讀取已儲存的比賽紀錄。', error);
      localStorage.removeItem(STORAGE_KEY);
      records = [];
      cursor = 0;
      state = defaultState();
      showToast('無法讀取先前紀錄，已開始新比賽。');
    }
  }

  function saveAndRender() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ records, cursor }));
    } catch (error) {
      console.error('無法儲存比賽紀錄。', error);
      showToast('儲存失敗，請檢查瀏覽器儲存空間。');
    }
    render();
  }

  function addRecord(label, nextState, type = 'play') {
    records = records.slice(0, cursor);
    const location = type === 'setup' ? nextState : state;
    const batter = activeBatter(state);
    const pitcher = currentPitcher(state);
    const outs = nextState.endedWithThreeOuts ? 3 : nextState.outs;
    const endingBases = nextState.endedWithThreeOuts ? nextState.endedWithThreeOutsBases : null;
    delete nextState.endedWithThreeOuts;
    delete nextState.endedWithThreeOutsBases;
    records.push({
      label, type, outs, ...(endingBases ? { bases: endingBases } : {}),
      state: clone(nextState), inning: location.inning, half: location.half,
      batter: batter ? { name: batter.name, number: batter.number, position: batter.position } : null,
      pitcher: pitcher ? { name: pitcher.name, number: pitcher.number, position: pitcher.position } : null
    });
    cursor = records.length;
    state = nextState;
    selectedInning = location.inning;
    selectedHalf = location.half;
    saveAndRender();
    const recordList = $('#record-list');
    recordList.scrollTop = recordList.scrollHeight;
  }

  function nextBatter(gameState) {
    const team = activeTeamIndex(gameState);
    gameState.orderIndexes[team] = (gameState.orderIndexes[team] + 1) % 9;
    gameState.batterNumber = gameState.orderIndexes[team] + 1;
    gameState.batter = batterName(gameState);
    gameState.batterOverride = false;
  }
  function clearCount(gameState) { gameState.balls = 0; gameState.strikes = 0; }
  function scoreRun(gameState, teamIndex) {
    const inningIndex = gameState.inning - 1;
    while (gameState.teams[teamIndex].innings.length <= inningIndex) gameState.teams[teamIndex].innings.push(null);
    const innings = gameState.teams[teamIndex].innings;
    innings[inningIndex] = (innings[inningIndex] ?? 0) + 1;
    if (teamIndex === 1 && gameState.half === 'bottom' && gameState.inning >= 9
      && teamRuns(gameState.teams[1]) > teamRuns(gameState.teams[0])) {
      gameState.gameOver = true;
      gameState.walkOff = true;
    }
  }
  function awardWalk(gameState, teamIndex) {
    const [first, second, third] = gameState.bases;
    if (first && second && third) scoreRun(gameState, teamIndex);
    if (first && second) gameState.bases[2] = second;
    if (first) gameState.bases[1] = first;
    gameState.bases[0] = batterName(gameState);
  }
  function advanceHalfInning(gameState) {
    if (gameState.gameOver) return;
    gameState.endedWithThreeOuts = true;
    gameState.endedWithThreeOutsBases = [...gameState.bases];
    gameState.outs = 0;
    gameState.bases = [null, null, null];
    clearCount(gameState);
    if (gameState.half === 'top' && gameState.inning >= 9
      && teamRuns(gameState.teams[1]) > teamRuns(gameState.teams[0])) {
      gameState.gameOver = true;
      return;
    }
    if (gameState.half === 'bottom' && gameState.inning >= 9
      && teamRuns(gameState.teams[0]) !== teamRuns(gameState.teams[1])) {
      gameState.gameOver = true;
      return;
    }
    if (gameState.half === 'top') gameState.half = 'bottom';
    else { gameState.half = 'top'; gameState.inning += 1; }
    const battingTeam = gameState.teams[activeTeamIndex(gameState)];
    battingTeam.lineup.forEach((player) => {
      if (player.position === 'PH' && player.previousPosition) {
        player.position = player.previousPosition;
        delete player.previousPosition;
      }
    });
    gameState.batterNumber = gameState.orderIndexes[activeTeamIndex(gameState)] + 1;
    gameState.batter = batterName(gameState);
  }
  function recordOut(gameState) {
    if (gameState.gameOver) return;
    gameState.outs += 1;
    clearCount(gameState);
    nextBatter(gameState);
    if (gameState.outs >= 3) advanceHalfInning(gameState);
  }
  function recordAppearance(gameState, batter, result) {
    const teamIndex = activeTeamIndex(gameState);
    const player = batter || activeBatter(gameState);
    if (!player) return;
    const key = `${teamIndex}:${player.id}`;
    gameState.plateAppearances[key] ||= [];
    gameState.plateAppearances[key].push({ result, inning: gameState.inning, half: gameState.half });
  }
  function recordRunnerOuts(gameState, count, preserveCount = false) {
    if (gameState.gameOver) return;
    gameState.outs += count;
    if (!preserveCount) clearCount(gameState);
    if (gameState.outs >= 3) advanceHalfInning(gameState);
  }
  function countPitch(gameState) {
    const pitcher = currentPitcher(gameState);
    if (pitcher) gameState.pitcherCounts[pitcher.id] = (gameState.pitcherCounts[pitcher.id] || 0) + 1;
  }
  function actualPitch(play) {
    return !['intentional-walk', 'timeout-ball', 'timeout-strike', 'steal', 'pickoff'].includes(play);
  }
  function recordPlay(play) {
    if (state.gameOver) return;
    if (play === 'steal' || play === 'pickoff') {
      openRunnerEventDialog(play);
      return;
    }
    if (play === 'error') {
      openRunnerDialog(play);
      return;
    }
    if (play === 'fielder-choice') {
      if (!state.bases.some(Boolean)) return;
      openRunnerDialog(play);
      return;
    }
    if (['single', 'double'].includes(play) && state.bases.some(Boolean)) {
      openRunnerDialog(play);
      return;
    }
    if (play === 'force-out' && state.outs < 2 && state.bases.some(Boolean)) {
      openRunnerDialog(play);
      return;
    }
    if (play === 'out' && state.outs < 2 && state.bases.some(Boolean)) {
      openRunnerDialog(play);
      return;
    }
    if (play === 'sacrifice') {
      if (state.outs >= 2 || !state.bases.some(Boolean)) {
        showToast(state.outs >= 2 ? '兩人出局時不能記錄犧牲打。' : '壘上無人時不能記錄犧牲打。');
        return;
      }
      openRunnerDialog(play);
      return;
    }
    applyPlay(play);
  }
  function applyPlay(play, runnerDestinations) {
    if (state.gameOver) return;
    const next = clone(state);
    const offense = activeTeamIndex(next);
    const defense = fieldingTeamIndex(next);
    const batter = batterName(next);
    let label = playLabels[play];
    if (actualPitch(play)) countPitch(next);

    if (play === 'swinging-strike' || play === 'foul-tip' || play === 'called-strike' || play === 'foul' || play === 'timeout-strike') {
      if (play === 'foul') {
        if (next.strikes < 2) next.strikes += 1;
      } else {
        next.strikes += 1;
        if (next.strikes >= 3) {
          recordAppearance(next, activeBatter(next), '三振');
          recordOut(next);
        }
      }
      if (play === 'foul' && runnerDestinations) {
        const outs = moveRunners(next, runnerDestinations, offense);
        if (outs) recordRunnerOuts(next, outs, true);
      }
    } else if (play === 'ball' || play === 'timeout-ball') {
      next.balls += 1;
      if (next.balls === 4) {
        recordAppearance(next, activeBatter(next), '四壞保送');
        awardWalk(next, offense);
        clearCount(next);
        nextBatter(next);
        label = '壞球累計四球，打者保送';
      }
    } else if (play === 'uncaught-third-strike') {
      next.strikes += 1;
      recordAppearance(next, activeBatter(next), '不死三振上壘');
      awardWalk(next, offense);
      clearCount(next);
      nextBatter(next);
    } else if (play === 'hbp' || play === 'intentional-walk') {
      recordAppearance(next, activeBatter(next), play === 'hbp' ? '觸身球保送' : '故意四壞球保送');
      awardWalk(next, offense);
      clearCount(next);
      nextBatter(next);
    } else if (play === 'out') {
      recordAppearance(next, activeBatter(next), '接殺出局');
      if (runnerDestinations) {
        const runnerOuts = moveRunners(next, runnerDestinations, offense);
        recordCompletedOuts(next, runnerOuts + 1);
      } else {
        recordOut(next);
      }
    } else if (play === 'error') {
      next.teams[defense].errors += 1;
      const errorDestinations = runnerDestinations || Object.fromEntries(next.bases.map((runner, index) =>
        runner ? [index, Math.min(index + 2, 4)] : null).filter(Boolean));
      if (errorDestinations.batter === undefined) errorDestinations.batter = 1;
      const runnerOuts = Object.values(errorDestinations).filter((destination) => destination === 0).length;
      advanceHitRunners(next, 1, batter, offense, errorDestinations);
      recordAppearance(next, activeBatter(next), '失誤上壘');
      clearCount(next);
      nextBatter(next);
      if (runnerOuts) recordRunnerOuts(next, runnerOuts);
    } else if (play === 'steal') {
      return;
    } else if (play === 'sacrifice') {
      const runnerOuts = moveRunners(next, runnerDestinations || {}, offense);
      recordAppearance(next, activeBatter(next), '犧牲打');
      recordCompletedOuts(next, runnerOuts + 1);
    } else if (play === 'force-out') {
      const runnerOuts = moveRunners(next, runnerDestinations || {}, offense);
      const batterOut = runnerDestinations?.batter !== 1;
      if (!batterOut) next.bases[0] = batter;
      recordAppearance(next, activeBatter(next), '封殺出局');
      recordCompletedOuts(next, runnerOuts + Number(batterOut));
    } else if (play === 'fielder-choice') {
      const runnerOuts = Object.values(runnerDestinations || {}).filter((destination) => destination === 0).length;
      advanceHitRunners(next, 1, batter, offense, runnerDestinations);
      recordAppearance(next, activeBatter(next), '野手選擇');
      clearCount(next);
      nextBatter(next);
      if (runnerOuts) recordRunnerOuts(next, runnerOuts);
    } else {
      const hitBases = { single: 1, double: 2, triple: 3, 'home-run': 4 }[play];
      if (!hitBases) return;
      next.teams[offense].hits += 1;
      recordAppearance(next, activeBatter(next), playLabels[play]);
      const runnerOuts = Object.values(runnerDestinations || {}).filter((destination) => destination === 0).length;
      advanceHitRunners(next, hitBases, batter, offense, runnerDestinations);
      clearCount(next);
      nextBatter(next);
      if (runnerOuts) recordRunnerOuts(next, runnerOuts);
    }
    addRecord(label, next);
  }
  function moveRunners(gameState, destinations, teamIndex) {
    let outs = 0;
    const remaining = [null, null, null];
    gameState.bases.forEach((runner, index) => {
      if (!runner) return;
      const destination = destinations[index];
      if (destination === 0) outs += 1;
      else if (destination >= 1 && destination <= 3) remaining[destination - 1] = runner;
      else if (destination === 4) scoreRun(gameState, teamIndex);
      else remaining[index] = runner;
    });
    gameState.bases = remaining;
    return outs;
  }
  function recordCompletedOuts(gameState, count) {
    if (gameState.gameOver) return;
    gameState.outs += count;
    clearCount(gameState);
    nextBatter(gameState);
    if (gameState.outs >= 3) advanceHalfInning(gameState);
  }
  function advanceHitRunners(gameState, hitBases, batter, teamIndex, destinations = {}) {
    const runners = gameState.bases.map((runner, index) => ({ runner, index })).filter(({ runner }) => runner);
    gameState.bases = [null, null, null];
    for (const { runner, index } of runners) {
      const destination = destinations[index] ?? 4;
      if (destination === 0) continue;
      if (destination === 4) scoreRun(gameState, teamIndex);
      else gameState.bases[destination - 1] = runner;
    }
    const batterDestination = destinations.batter ?? (hitBases === 4 ? 4 : hitBases);
    if (batterDestination === 0) return;
    if (batterDestination === 4) scoreRun(gameState, teamIndex);
    else gameState.bases[batterDestination - 1] = batter;
  }

  function renderScoreboard() {
    const maxInnings = Math.max(9, state.inning, ...state.teams.map((team) => team.innings.length));
    const columns = Array.from({ length: maxInnings }, (_, index) =>
      `<th class="${index + 1 === state.inning ? 'current-inning' : ''}">${index + 1}</th>`).join('');
    $('#score-head').innerHTML = `<tr><th>球隊</th>${columns}<th>R</th><th>H</th><th>E</th></tr>`;
    $('#score-body').innerHTML = state.teams.map((team, index) => {
      const inningCells = Array.from({ length: maxInnings }, (_, inningIndex) => {
        const currentInning = inningIndex === state.inning - 1;
        const currentFinalInning = state.gameOver && currentInning;
        const homeDidNotBat = currentInning && index === 1 && state.half === 'top';
        const score = inningIndex < state.inning || currentFinalInning ? team.innings[inningIndex] ?? 0 : null;
        const displayScore = homeDidNotBat ? state.gameOver ? 'X' : '·'
          : currentFinalInning && index === 1 && state.walkOff ? `${score}X`
            : score ?? '·';
        return `<td class="${inningIndex + 1 === state.inning ? 'current-inning' : ''}">${displayScore}</td>`;
      }).join('');
      const runs = teamRuns(team);
      return `<tr><td><span class="team-indicator">${index === 0 ? '客' : '主'}</span>${escapeHtml(team.name)}</td>${inningCells}<td class="total-cell">${runs}</td><td>${team.hits}</td><td>${team.errors}</td></tr>`;
    }).join('');
  }

  function renderLineup() {
    [0, 1].forEach((teamIndex) => {
      const team = state.teams[teamIndex];
      const id = teamIndex === 0 ? 'away' : 'home';
      $(`#${id}-lineup-title`).textContent = `${team.name}先發`;
      const form = $('#lineup-form');
      form.elements[`${id}PitcherName`].value = team.pitcher.name || '';
      form.elements[`${id}PitcherNumber`].value = team.pitcher.number;
      $(`#${id}-lineup`).innerHTML = team.lineup.map((player, index) => `
        <div class="lineup-row">
          <span class="lineup-order">${index + 1} 棒</span>
          <input name="${id}-name-${index}" aria-label="${team.name}第${index + 1}棒姓名" maxlength="30" value="${escapeHtml(player.name)}">
          <select name="${id}-position-${index}" aria-label="${team.name}第${index + 1}棒守位">${positionOptions(player.position === 'P' ? 'DH' : player.position)}</select>
          <input name="${id}-number-${index}" aria-label="${team.name}第${index + 1}棒背號" maxlength="6" value="${escapeHtml(player.number)}">
        </div>`).join('');
    });
  }
  function positionOptions(selected = '') {
    const pinchHitterOption = selected === 'PH' ? '<option value="PH" selected>PH 代打</option>' : '';
    return pinchHitterOption + lineupPositions.map(([code, name]) => `<option value="${code}" ${selected === code ? 'selected' : ''}>${code} ${name}</option>`).join('');
  }
  function currentHalfRecords() {
    const activeRecords = records.slice(0, cursor);
    const innings = [...new Set([...activeRecords.map((record) => record.inning), state.inning])]
      .sort((first, second) => first - second);
    return { activeRecords, innings };
  }
  function renderHistory() {
    const { activeRecords, innings } = currentHalfRecords();
    if (!innings.includes(selectedInning)) selectedInning = state.inning;
    if (!innings.includes(selectedInning)) selectedInning = innings[innings.length - 1];
    $('#record-total').textContent = records.length;
    $('#history-inning-label').textContent = `第 ${selectedInning} 局`;
    $('#previous-inning').disabled = selectedInning <= innings[0];
    $('#next-inning').disabled = selectedInning >= innings[innings.length - 1];
    $('#half-tabs').innerHTML = ['top', 'bottom'].map((half) => {
      const count = activeRecords.filter((record) => record.inning === selectedInning && record.half === half).length;
      return `<button type="button" role="tab" aria-selected="${half === selectedHalf}" class="half-tab ${half === selectedHalf ? 'selected' : ''}" data-half="${half}">${half === 'top' ? '上半局' : '下半局'} <span>${count}</span></button>`;
    }).join('');
    document.querySelectorAll('[data-half]').forEach((button) => button.addEventListener('click', () => {
      selectedHalf = button.dataset.half;
      renderHistory();
    }));
    const visibleRecords = activeRecords.map((record, index) => ({ record, index }))
      .filter(({ record }) => record.inning === selectedInning && record.half === selectedHalf);
    $('#record-list').innerHTML = visibleRecords.map(({ record, index }) => {
      const position = index + 1;
      const batter = record.batter
        ? `打者 ${displayPlayerName(record.batter)} #${record.batter.number} ${record.batter.position}` : '';
      const pitcher = record.pitcher
        ? `投手 ${displayPlayerName(record.pitcher)} #${record.pitcher.number} ${record.pitcher.position}` : '';
      const runnerStatus = (record.bases || record.state.bases || []).map((runner, baseIndex) =>
        runner ? `${bases[baseIndex]} ${runner}` : '').filter(Boolean);
      const runnerSummary = runnerStatus.length ? `壘上：${runnerStatus.join('、')}` : '壘上：無';
      const outs = record.outs ?? (record.state.outs === 0
        && (record.state.inning !== record.inning || record.state.half !== record.half) ? 3 : record.state.outs);
      return `<li class="record-item"><div class="record-entry"><span class="record-number">${String(position).padStart(2, '0')}</span><div class="record-content"><span class="record-label">${escapeHtml(record.label)}</span><span class="record-people">${escapeHtml([batter, pitcher].filter(Boolean).join(' · ') || '比賽狀態設定')}</span><span class="record-runners">${escapeHtml(runnerSummary)}</span></div><span class="record-meta">${record.state.balls}-${record.state.strikes} · ${outs} 出局</span></div></li>`;
    }).join('');
    $('#history-help').textContent = `顯示 ${halfLabel(selectedInning, selectedHalf)}；紀錄可在此區域捲動閱讀。`;
  }

  function render() {
    renderScoreboard();
    renderLineup();
    $('#inning-number').textContent = state.inning;
    $('#inning-number').hidden = state.gameOver;
    $('#inning-half').textContent = state.gameOver ? '比賽結束' : state.half === 'top' ? '局上' : '局下';
    $('#game-meta').textContent = state.gameInfo || '比賽資訊';
    $('#away-team-name').textContent = state.teams[0].name;
    $('#home-team-name').textContent = state.teams[1].name;
    $('.current-score').setAttribute('aria-label', `${state.teams[0].name} ${teamRuns(state.teams[0])} 比 ${teamRuns(state.teams[1])} ${state.teams[1].name}`);
    $('#away-score').textContent = teamRuns(state.teams[0]);
    $('#home-score').textContent = teamRuns(state.teams[1]);
    const batter = activeBatter();
    $('#batter-name').textContent = batter ? `${state.orderIndexes[activeTeamIndex()] + 1} 棒 · ${displayPlayerName(batter)} #${batter.number}` : state.batter;
    $('#batting-side').textContent = `${state.teams[activeTeamIndex()].name}進攻`;
    $('#fielding-team').textContent = `${state.teams[fieldingTeamIndex()].name}守備`;
    $('#ball-count').textContent = state.balls;
    $('#strike-count').textContent = state.strikes;
    $('#out-count').textContent = state.outs;
    document.querySelectorAll('[data-play]').forEach((button) => { button.disabled = state.gameOver; });
    document.querySelector('[data-play="sacrifice"]').disabled = state.gameOver || state.outs >= 2 || !state.bases.some(Boolean);
    document.querySelector('[data-play="fielder-choice"]').disabled = state.gameOver || !state.bases.some(Boolean);
    document.querySelector('[data-play="uncaught-third-strike"]').disabled = state.gameOver || state.outs < 2 && Boolean(state.bases[0]);
    $('#ball-dots').innerHTML = Array.from({ length: 3 }, (_, i) => `<span class="count-dot ball ${i < state.balls ? 'active' : ''}"></span>`).join('');
    $('#strike-dots').innerHTML = Array.from({ length: 2 }, (_, i) => `<span class="count-dot strike ${i < state.strikes ? 'active' : ''}"></span>`).join('');
    $('#out-lights').innerHTML = Array.from({ length: 2 }, (_, i) => `<span class="out-light ${i < state.outs ? 'active' : ''}"></span>`).join('');
    const hasRunners = state.bases.some(Boolean);
    document.querySelector('[data-play="steal"]').disabled = state.gameOver || !hasRunners;
    document.querySelector('[data-play="pickoff"]').disabled = state.gameOver || !hasRunners;
    const pitcher = currentPitcher();
    $('#pitch-count').textContent = pitcher ? state.pitcherCounts[pitcher.id] || 0 : 0;
    ['first', 'second', 'third'].forEach((base, index) => {
      const runner = state.bases[index];
      $(`#runner-${base}`).textContent = runner || '空';
      $(`#field-runner-${base}`).textContent = runner ? runner : '';
      $(`#field-runner-${base}`).parentElement.classList.toggle('occupied', Boolean(runner));
      $(`#field-runner-${base}`).parentElement.title = runner ? `${bases[index]}：${runner}` : `${bases[index]}：空`;
    });
    const fielding = state.teams[fieldingTeamIndex()];
    const fieldPlayers = [
    ...fielding.lineup.map((player) => player.position === 'PH' && player.previousPosition
      ? { ...player, position: player.previousPosition } : player)
      .filter((player) => player.position !== 'DH' && player.position !== 'P'),
    fielding.pitcher
    ];
    document.querySelectorAll('.field-position').forEach((element) => {
      const player = fieldPlayers.find((candidate) => candidate.position === element.dataset.code);
      const playerName = String(player?.name || '').trim();
      const short = player ? `${playerName || `#${player.number}`}` : '尚無球員';
      element.textContent = playerName ? `${element.dataset.code}: ${playerName}` : element.dataset.code;
      element.title = `${element.dataset.position}：${short}`;
      element.setAttribute('aria-label', element.title);
    });
    const batterKey = batter ? `${activeTeamIndex()}:${batter.id}` : '';
    const appearances = state.plateAppearances[batterKey] || [];
    $('#batter-history').innerHTML = appearances.length
      ? appearances.slice(-8).map((appearance) => `<span class="appearance-chip">${escapeHtml(appearance.result)}</span>`).join('')
      : '<span class="appearance-empty">無</span>';
    $('#lineup-inning').textContent = '';
    $('#scorebook-teams').innerHTML = state.teams.map((team, teamIndex) => {
      const teamBats = activeTeamIndex() === teamIndex;
      const onFieldPitcher = !teamBats;
      const nextBatterIndex = state.orderIndexes[teamIndex];
      const pitcher = team.pitcher || team.lineup.find((player) => player.position === 'P');
      const pitcherName = String(pitcher?.name || '').trim();
      const sideLabel = teamIndex === 0 ? '客隊' : '主隊';
      const teamLabel = team.name === sideLabel ? sideLabel : `${sideLabel}・${escapeHtml(team.name)}`;
      return `<section class="scorebook-team"><h3><b>${teamLabel}</b><span>${teamBats ? '進攻' : '守備'}</span></h3><ol>${team.lineup.map((player, index) => {
        const currentBatter = teamBats && index === state.orderIndexes[teamIndex];
        const nextBatter = !teamBats && index === nextBatterIndex;
        return `<li class="${currentBatter ? 'current-batter' : ''} ${nextBatter ? 'next-batter' : ''}"><span class="scorebook-order">${index + 1}</span><span class="scorebook-name">${escapeHtml(displayPlayerName(player))} <small>#${escapeHtml(player.number)}</small></span><span class="scorebook-position">${escapeHtml(player.position)}</span></li>`;
      }).join('')}</ol><div class="scorebook-pitcher ${onFieldPitcher ? 'fielding-pitcher' : ''}"><span>P</span>${pitcherName ? `${escapeHtml(pitcherName)} ` : ''}#${escapeHtml(pitcher?.number || '')}</div></section>`;
    }).join('');
    $('#undo-button').disabled = cursor === 0;
    renderHistory();
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  }
  function showRunnerError(message) {
    const error = $('#runner-error');
    error.textContent = message;
    error.hidden = false;
  }
  function clearRunnerError() {
    const error = $('#runner-error');
    error.textContent = '';
    error.hidden = true;
  }
  function batterIsFixedOut() {
    return ['out', 'force-out', 'sacrifice'].includes(pendingHit);
  }
  function openRunnerDialog(play) {
    pendingHit = play;
    const hitBases = { single: 1, double: 2, triple: 3, 'home-run': 4, error: 1, 'fielder-choice': 1 }[play];
    const batter = batterName();
    const runners = state.bases.map((runner, index) => ({ runner, index })).filter(({ runner }) => runner);
    pendingDestinations = {};
    runners.forEach(({ index }) => {
      if (play === 'foul') pendingDestinations[index] = index + 1;
      else if (play === 'sacrifice') pendingDestinations[index] = Math.min(index + 2, 4);
      else if (play === 'fielder-choice') pendingDestinations[index] = index + 1;
      else if (['out', 'force-out'].includes(play)) pendingDestinations[index] = index + 1;
      else pendingDestinations[index] = Math.min(index + hitBases + 1, 4);
    });
    if (play === 'fielder-choice') {
      pendingDestinations.batter = 1;
      const firstOccupiedBase = runners[0]?.index;
      if (firstOccupiedBase !== undefined) pendingDestinations[firstOccupiedBase] = 0;
    } else if (hitBases) pendingDestinations.batter = hitBases === 4 ? 4 : hitBases;
    else if (['out', 'force-out', 'sacrifice'].includes(play)) pendingDestinations.batter = 0;
    const labels = { out: '接殺出局', sacrifice: '犧牲打', 'force-out': '封殺出局', foul: '界外球', single: '一壘安打', double: '二壘安打', triple: '三壘安打', 'home-run': '全壘打', error: '失誤上壘', 'fielder-choice': '野手選擇' };
    clearRunnerError();
    $('#runner-dialog-title').textContent = '輸入跑壘結果';
    $('#runner-dialog-description').textContent = play === 'fielder-choice'
      ? '打者固定上一壘；至少選擇一位跑者出局，預設由最低壘包跑者出局。'
      : `${labels[play]}：拖曳跑者到目標位置，或使用選單；選擇出局可記錄跑者出局。`;
    $('#runner-submit').textContent = `記錄${labels[play]}`;
    $('#runner-board').hidden = false;
    $('#runner-choices').innerHTML = runners.map(({ runner, index }) =>
      runnerChoice(index, runner)).join('')
      + (['single', 'double', 'triple', 'error'].includes(play) ? runnerChoice('batter', batter, '打者')
        : play === 'fielder-choice' ? `<div class="runner-choice batter-choice"><span>打者</span><strong>${escapeHtml(batter)}</strong><span class="fixed-destination">固定上一壘</span></div>`
        : hitBases ? `<div class="runner-choice batter-choice"><span>打者</span><strong>${escapeHtml(batter)}</strong><span class="fixed-destination">全壘打回本壘</span></div>`
        : `<div class="runner-choice batter-choice"><span>打者</span><strong>${escapeHtml(batter)}</strong><span class="fixed-destination">${play === 'sacrifice' ? '犧牲打出局' : '打者出局'}</span></div>`);
    syncRunnerSelects();
    renderRunnerDragBoard();
    $('#runner-dialog').showModal();
  }
  function destinationOptions(selected, runnerKey) {
    const fixedOut = Number(batterIsFixedOut());
    const otherRunnerOuts = Object.entries(pendingDestinations)
      .filter(([key, value]) => key !== String(runnerKey) && (!fixedOut || key !== 'batter') && value === 0).length;
    const outUnavailable = selected !== 0 && state.outs + fixedOut + otherRunnerOuts >= 3;
    const batterCannotBeOut = pendingHit === 'error' && String(runnerKey) === 'batter';
    const options = [`<option value="0" ${outUnavailable || batterCannotBeOut ? 'disabled' : ''}>出局</option>`];
    bases.forEach((base, index) => {
      const destination = index + 1;
      const occupiedByOther = Object.entries(pendingDestinations)
        .some(([key, value]) => key !== String(runnerKey) && value === destination);
      const disabled = occupiedByOther;
      const label = destination === Number(runnerKey) + 1 ? `${base}（原壘安全）` : base;
      options.push(`<option value="${destination}" ${selected === destination ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${label}${disabled ? '（已有人）' : ''}</option>`);
    });
    options.push(`<option value="4" ${selected === 4 ? 'selected' : ''}>本壘（得分）</option>`);
    return options.join('');
  }
  function runnerChoice(index, runner, label = `${bases[index]}跑者`) {
    const key = String(index);
    const selected = pendingDestinations[key];
    return `<label class="runner-choice" data-runner-index="${key}"><span>${label}</span><strong>${escapeHtml(runner)}</strong><select name="runner-${key}">${destinationOptions(selected, key)}</select></label>`;
  }
  function syncRunnerSelects() {
    $('#runner-choices').querySelectorAll('select[name^="runner-"]').forEach((select) => {
      const key = select.name.slice('runner-'.length);
      select.value = String(pendingDestinations[key]);
      select.onchange = () => {
        pendingDestinations[key] = Number(select.value);
        clearRunnerError();
        syncRunnerSelects();
        renderRunnerDragBoard();
      };
      [...select.options].forEach((option) => {
        if (option.value === '0') {
          const fixedOut = Number(batterIsFixedOut());
          const otherRunnerOuts = Object.entries(pendingDestinations)
            .filter(([otherKey, value]) => otherKey !== key && (!fixedOut || otherKey !== 'batter') && value === 0).length;
          option.disabled = pendingHit === 'error' && key === 'batter'
            || pendingDestinations[key] !== 0
              && state.outs + fixedOut + otherRunnerOuts >= 3;
          return;
        }
        if (option.value === '4') return;
        const occupiedByOther = Object.entries(pendingDestinations)
          .some(([otherKey, value]) => otherKey !== key && value === Number(option.value));
        option.disabled = occupiedByOther;
        option.textContent = option.disabled
          ? `${bases[Number(option.value) - 1]}（已有人）`
          : bases[Number(option.value) - 1];
      });
    });
  }
  function renderRunnerDragBoard() {
    $('#runner-pool').textContent = '拖曳跑者卡片至目標壘包；相同壘包的跑者會互換位置';
    document.querySelectorAll('.runner-destination').forEach((zone) => {
      const destination = Number(zone.dataset.destination);
      const occupants = Object.entries(pendingDestinations).filter(([, value]) => value === destination);
      zone.classList.toggle('drop-target', false);
      zone.querySelector('span').innerHTML = occupants.map(([index]) => {
        const runner = index === 'batter' ? batterName() : state.bases[Number(index)];
        const fixed = index === 'batter' && (batterIsFixedOut()
          || ['home-run', 'fielder-choice'].includes(pendingHit));
        const fixedLabel = pendingHit === 'fielder-choice' ? '打者固定上一壘' : '打者固定出局';
        return `<span class="drag-runner ${fixed ? 'fixed-runner' : ''}" ${fixed ? '' : 'draggable="true"'} data-runner-index="${index}" title="${fixed ? fixedLabel : `拖曳以移動 ${escapeHtml(runner)}`}">${escapeHtml(runner)}${index === 'batter' ? '（打者）' : ''}</span>`;
      }).join('');
      zone.ondragover = onRunnerDragOver;
      zone.ondragleave = onRunnerDragLeave;
      zone.ondrop = onRunnerDrop;
    });
    syncRunnerSelects();
    document.querySelectorAll('.drag-runner').forEach((chip) => chip.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', chip.dataset.runnerIndex);
      event.dataTransfer.effectAllowed = 'move';
    }));
  }
  function onRunnerDragOver(event) {
    event.preventDefault();
    event.currentTarget.classList.add('drop-target');
  }
  function onRunnerDragLeave(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.classList.remove('drop-target');
  }
  function onRunnerDrop(event) {
    event.preventDefault();
    const key = event.dataTransfer.getData('text/plain');
    const destination = Number(event.currentTarget.dataset.destination);
    const previous = pendingDestinations[key];
    if (pendingHit === 'error' && key === 'batter' && destination === 0) {
      showRunnerError('失誤上壘時，打者不能記為出局。');
      return;
    }
    if (['out', 'force-out'].includes(pendingHit)
      && key === 'batter' && destination !== 0) return;
    const fixedOut = Number(batterIsFixedOut());
    const otherRunnerOuts = Object.entries(pendingDestinations)
      .filter(([otherKey, value]) => otherKey !== key && (!fixedOut || otherKey !== 'batter') && value === 0).length;
    if (destination === 0 && previous !== 0 && state.outs + fixedOut + otherRunnerOuts >= 3) {
      showRunnerError('本次結果不能超過該局剩餘出局數。');
      return;
    }
    const occupant = destination >= 1 && destination <= 3
      ? Object.entries(pendingDestinations).find(([otherKey, value]) => otherKey !== key && value === destination)
      : null;
    pendingDestinations[key] = destination;
    clearRunnerError();
    if (occupant) pendingDestinations[occupant[0]] = previous;
    renderRunnerDragBoard();
  }

  document.querySelectorAll('[data-play]').forEach((button) => button.addEventListener('click', () => recordPlay(button.dataset.play)));
  $('#previous-inning').addEventListener('click', () => {
    const { innings } = currentHalfRecords();
    const previous = innings.filter((inning) => inning < selectedInning).at(-1);
    if (previous) selectedInning = previous;
    renderHistory();
  });
  $('#next-inning').addEventListener('click', () => {
    const { innings } = currentHalfRecords();
    selectedInning = innings.find((inning) => inning > selectedInning) || selectedInning;
    renderHistory();
  });
  $('#undo-button').addEventListener('click', () => {
    if (!cursor) return;
    records.splice(cursor - 1, 1);
    cursor -= 1;
    state = replay(records, cursor);
    saveAndRender();
    showToast('已復原並移除上一筆紀錄。');
  });
  $('#new-game-button').addEventListener('click', () => {
    if (!window.confirm('確定重設比賽？目前的逐球紀錄也會一併清除。')) return;
    records = [];
    cursor = 0;
    selectedInning = 0;
    selectedHalf = 'top';
    state = defaultState();
    saveAndRender();
    showToast('比賽已重設。');
  });

  const setupDialog = $('#setup-dialog');
  function updateSetupBatterOptions(preferredIndex) {
    const form = $('#setup-form');
    const teamIndex = activeTeamIndex(setupGamePosition());
    const lineup = state.teams[teamIndex].lineup;
    form.elements.batter.innerHTML = lineup.map((player, index) =>
      `<option value="${index}">${index + 1} 棒 · ${escapeHtml(displayPlayerName(player))} #${escapeHtml(player.number)} (${escapeHtml(player.position)})</option>`).join('');
    form.elements.batter.value = String(preferredIndex ?? state.orderIndexes[teamIndex]);
  }
  function updateSetupRunnerOptions(selectedValues = {}) {
    const form = $('#setup-form');
    const teamIndex = activeTeamIndex(setupGamePosition());
    const lineup = state.teams[teamIndex].lineup;
    ['first', 'second', 'third'].forEach((base) => {
      const select = form.elements[base];
      const selected = selectedValues[base] ?? select.value;
      const options = [`<option value="">空</option>`, ...lineup.map((player) => {
        const runnerName = displayPlayerName(player);
        return `<option value="${escapeHtml(runnerName)}">${escapeHtml(runnerName)} #${escapeHtml(player.number)}</option>`;
      })];
      if (selected && !lineup.some((player) => displayPlayerName(player) === selected)) {
        options.push(`<option value="${escapeHtml(selected)}">${escapeHtml(selected)}（名單外）</option>`);
      }
      select.innerHTML = options.join('');
      select.value = selected || '';
    });
  }
  function renderSetupScoreboard(preserveCurrentValues = true) {
    const form = $('#setup-form');
    const priorScores = new Map(preserveCurrentValues
      ? [...form.querySelectorAll('.setup-inning-score')].map((input) =>
        [`${input.dataset.teamIndex}-${input.dataset.inning}`, input.value])
      : []);
    const priorStats = new Map(preserveCurrentValues
      ? [...form.querySelectorAll('.setup-team-stat')].map((input) => [input.name, input.value])
      : []);
    const editedInningCount = Math.max(0, ...[...priorScores.keys()]
      .map((key) => Number(key.split('-')[1]) + 1));
    const inningCount = Math.min(30, Math.max(9, state.inning,
      editedInningCount + 1, ...state.teams.map((team) => team.innings.length)));
    $('#setup-score-head').innerHTML = `<tr><th>球隊</th>${Array.from({ length: inningCount }, (_, index) =>
      `<th>${index + 1}</th>`).join('')}<th>R</th><th>H</th><th>E</th></tr>`;
    $('#setup-score-body').innerHTML = state.teams.map((team, teamIndex) => {
      const inningInputs = Array.from({ length: inningCount }, (_, inningIndex) => {
        const key = `${teamIndex}-${inningIndex}`;
        const inningHasStarted = inningIndex < state.inning - 1
          || inningIndex === state.inning - 1
            && (state.half === 'bottom' || teamIndex === 0);
        const value = priorScores.has(key) ? priorScores.get(key)
          : team.innings[inningIndex] ?? (inningHasStarted ? 0 : '');
        return `<td><input class="setup-inning-score" data-team-index="${teamIndex}" data-inning="${inningIndex}" type="number" min="0" max="9999" step="1" value="${escapeHtml(value)}" aria-label="${escapeHtml(team.name)}第${inningIndex + 1}局得分"></td>`;
      }).join('');
      const hits = priorStats.get(`hits-${teamIndex}`) ?? team.hits;
      const errors = priorStats.get(`errors-${teamIndex}`) ?? team.errors;
      return `<tr data-score-team="${teamIndex}"><th scope="row">${escapeHtml(team.name)}</th>${inningInputs}<td class="setup-score-total">${teamRuns(team)}</td><td><input class="setup-team-stat" data-team-index="${teamIndex}" name="hits-${teamIndex}" type="number" min="0" max="9999" step="1" value="${escapeHtml(hits)}" aria-label="${escapeHtml(team.name)}安打數"></td><td><input class="setup-team-stat" data-team-index="${teamIndex}" name="errors-${teamIndex}" type="number" min="0" max="9999" step="1" value="${escapeHtml(errors)}" aria-label="${escapeHtml(team.name)}失誤數"></td></tr>`;
    }).join('');
    updateSetupScoreTotals();
  }
  function updateSetupScoreTotals() {
    document.querySelectorAll('[data-score-team]').forEach((row) => {
      const total = [...row.querySelectorAll('.setup-inning-score')]
        .reduce((sum, input) => sum + (input.value === '' ? 0 : Number(input.value)), 0);
      row.querySelector('.setup-score-total').textContent = total;
    });
  }
  function setupGamePosition() {
    const inningScores = [0, 1].map((teamIndex) =>
      [...document.querySelectorAll(`.setup-inning-score[data-team-index="${teamIndex}"]`)]
        .map((input) => input.value === '' ? null : Number(input.value)));
    let lastFilledInning = -1;
    inningScores.forEach((scores) => scores.forEach((score, inningIndex) => {
      if (score !== null) lastFilledInning = Math.max(lastFilledInning, inningIndex);
    }));
    if (lastFilledInning === -1) return { inning: state.inning, half: state.half };
    return {
      inning: lastFilledInning + 1,
      half: inningScores[1][lastFilledInning] === null ? 'top' : 'bottom'
    };
  }
  $('#setup-button').addEventListener('click', () => {
    const form = $('#setup-form');
    renderSetupScoreboard(false);
    updateSetupBatterOptions(state.orderIndexes[activeTeamIndex(setupGamePosition())]);
    form.elements.balls.value = state.balls;
    form.elements.strikes.value = state.strikes;
    form.elements.outs.value = state.outs;
    updateSetupRunnerOptions(Object.fromEntries(['first', 'second', 'third']
      .map((base, index) => [base, state.bases[index] || ''])));
    setupDialog.showModal();
  });
  $('#setup-form').addEventListener('input', (event) => {
    $('#setup-error').hidden = true;
    $('#setup-error').textContent = '';
    if (!event.target.matches('.setup-inning-score')) return;
    updateSetupScoreTotals();
    const targetInning = Number(event.target.dataset.inning);
    const currentInningCount = $('#setup-score-head').querySelectorAll('th').length - 4;
    if (event.target.value !== '' && targetInning === currentInningCount - 1 && currentInningCount < 30) {
      const teamIndex = event.target.dataset.teamIndex;
      renderSetupScoreboard();
      $(`.setup-inning-score[data-team-index="${teamIndex}"][data-inning="${targetInning}"]`).focus();
    }
    const position = setupGamePosition();
    updateSetupBatterOptions(state.orderIndexes[activeTeamIndex(position)]);
    updateSetupRunnerOptions();
  });
  $('#cancel-setup').addEventListener('click', () => setupDialog.close());
  $('#close-setup').addEventListener('click', () => setupDialog.close());
  $('#setup-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const setupError = $('#setup-error');
    setupError.hidden = true;
    setupError.textContent = '';
    const data = new FormData(event.currentTarget);
    const next = clone(state);
    next.balls = Number(data.get('balls'));
    next.strikes = Number(data.get('strikes'));
    next.outs = Number(data.get('outs'));
    next.bases = ['first', 'second', 'third'].map((base) => String(data.get(base)).trim() || null);
    let lastScoredInning = 0;
    for (const [teamIndex, team] of next.teams.entries()) {
      const scoreInputs = [...event.currentTarget.querySelectorAll(`.setup-inning-score[data-team-index="${teamIndex}"]`)];
      const values = scoreInputs.map((input) => input.value === '' ? null : Number(input.value));
      let lastFilledIndex = -1;
      values.forEach((score, index) => { if (score !== null) lastFilledIndex = index; });
      const missingIndex = values.slice(0, lastFilledIndex).findIndex((score) => score === null);
      if (missingIndex !== -1) {
        setupError.textContent = `${team.name}第 ${missingIndex + 1} 局尚未設定，請填入得分（無得分請填 0）。`;
        setupError.hidden = false;
        return;
      }
      if (values.some((score) => score !== null && (!Number.isInteger(score) || score < 0))) {
        setupError.textContent = `${team.name}各局得分必須是 0 或以上的整數。`;
        setupError.hidden = false;
        return;
      }
      lastScoredInning = Math.max(lastScoredInning, lastFilledIndex + 1);
      while (values.length > 9 && values.at(-1) === null) values.pop();
      team.innings = values;
      team.hits = Number(data.get(`hits-${teamIndex}`));
      team.errors = Number(data.get(`errors-${teamIndex}`));
    }
    const position = setupGamePosition();
    next.inning = lastScoredInning || position.inning;
    next.half = position.half;
    next.gameOver = false;
    next.walkOff = false;
    const battingTeam = activeTeamIndex(next);
    next.orderIndexes[battingTeam] = Number(data.get('batter'));
    next.batterNumber = next.orderIndexes[battingTeam] + 1;
    next.batter = next.teams[battingTeam].lineup[next.orderIndexes[battingTeam]].name;
    next.batterOverride = false;
    addRecord('直接設定比賽狀態', next, 'setup');
    setupDialog.close();
    showToast('已套用設定，記分板已更新。');
  });

  const lineupDialog = $('#lineup-dialog');
  $('#lineup-button').addEventListener('click', () => {
    const form = $('#lineup-form');
    form.elements.awayName.value = state.teams[0].name;
    form.elements.homeName.value = state.teams[1].name;
    form.elements.gameInfo.value = state.gameInfo;
    renderLineup();
    lineupDialog.showModal();
  });
  $('#lineup-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const lineupError = $('#lineup-error');
    lineupError.hidden = true;
    lineupError.textContent = '';
    for (const teamId of ['away', 'home']) {
      const selects = [...$(`#${teamId}-lineup`).querySelectorAll('select')];
      const selectedPositions = selects.map((select) => select.value);
      const duplicateIndex = selectedPositions.findIndex((position, index) =>
        position !== 'PH' && selectedPositions.indexOf(position) !== index);
      if (duplicateIndex >= 0) {
        lineupError.textContent = `${teamId === 'away' ? '客隊' : '主隊'}守位不可重複，請調整先發名單。`;
        lineupError.hidden = false;
        selects[duplicateIndex].focus();
        return;
      }
    }
    const next = clone(state);
    next.teams.forEach((team, teamIndex) => {
      const key = teamIndex === 0 ? 'away' : 'home';
      team.name = String(data.get(teamIndex === 0 ? 'awayName' : 'homeName')).trim();
      const pitcherNameField = `${key}PitcherName`;
      const pitcherNumberField = `${key}PitcherNumber`;
      team.pitcher = {
        ...team.pitcher,
        name: String(data.get(pitcherNameField)).trim(),
        number: String(data.get(pitcherNumberField)).trim(),
        position: 'P'
      };
      team.lineup = Array.from({ length: 9 }, (_, index) => ({
        ...team.lineup[index],
        name: String(data.get(`${key}-name-${index}`)).trim(),
        position: String(data.get(`${key}-position-${index}`)),
        number: String(data.get(`${key}-number-${index}`)).trim()
      }));
    });
    if (!next.batterOverride) next.batter = batterName(next);
    next.gameInfo = String(data.get('gameInfo')).trim();
    addRecord('更新比賽資訊與先發名單', next, 'setup');
    lineupDialog.close();
    showToast('已記錄比賽資訊與先發名單。');
  });

  const substitutionDialog = $('#substitution-dialog');
  function openSubstitution(mode) {
    substitutionMode = mode;
    const form = $('#substitution-form');
    $('#substitution-title').textContent = mode === 'defense' ? '更換守備' : '代打／代跑';
    $('#substitution-description').textContent = mode === 'defense'
      ? '換下場或交換守備位置。'
      : '選擇替換目前打者或壘上跑者；新球員會接替其打序與守備位置。';
    $('#defense-mode-field').hidden = mode !== 'defense';
    $('#offense-mode-field').hidden = mode !== 'offense';
    $('#substitution-target-field').hidden = false;
    $('#substitution-target-label').textContent = '換下場球員';
    form.elements.defenseMode.value = 'replace';
    form.elements.offenseMode.value = 'batter';
    form.elements.name.value = '';
    form.elements.number.value = '';
    updateSubstitutionSlots();
    substitutionDialog.showModal();
  }
  $('#defense-change-button').addEventListener('click', () => openSubstitution('defense'));
  $('#pinch-hit-button').addEventListener('click', () => openSubstitution('offense'));
  $('#substitution-form').elements.defenseMode.addEventListener('change', updateSubstitutionSlots);
  $('#substitution-form').elements.offenseMode.addEventListener('change', updateSubstitutionSlots);
  function updateSubstitutionSlots() {
    const form = $('#substitution-form');
    const teamIndex = substitutionMode === 'defense' ? fieldingTeamIndex() : activeTeamIndex();
    const team = state.teams[teamIndex];
    const previousSlot = form.elements.slot.value;
    const defenseMode = form.elements.defenseMode.value;
    const offenseMode = form.elements.offenseMode.value;
    const currentBatterIndex = state.orderIndexes[activeTeamIndex()];
    const available = team.lineup.map((player, index) => ({ player, index }))
      .filter(({ player, index }) => substitutionMode === 'defense'
        ? player.position !== 'DH' && player.position !== 'P'
        : offenseMode === 'batter' ? index === currentBatterIndex : false);
    const options = available.map(({ player, index }) => substitutionMode === 'defense'
      ? `<option value="${index}">${escapeHtml(player.position === 'PH' ? player.previousPosition || 'PH' : player.position)} · ${escapeHtml(player.name)} #${escapeHtml(player.number)}</option>`
      : `<option value="${index}">${index + 1} 棒 · ${escapeHtml(displayPlayerName(player))} (${escapeHtml(player.position)})</option>`).join('');
    const runnerOptions = offenseMode === 'runner'
      ? state.bases.map((runner, index) => runner
        ? `<option value="runner:${index}">${bases[index]} · ${escapeHtml(runner)}</option>` : '').join('')
      : '';
    form.elements.slot.innerHTML = substitutionMode === 'offense' && offenseMode === 'runner'
      ? runnerOptions
      : substitutionMode === 'defense' && defenseMode === 'replace'
      ? `<option value="pitcher">P · ${escapeHtml(displayPlayerName(team.pitcher))} #${escapeHtml(team.pitcher.number)}</option>${options}`
      : options;
    if ([...form.elements.slot.options].some((option) => option.value === previousSlot)) form.elements.slot.value = previousSlot;
    const slotIndex = Number(form.elements.slot.value);
    form.elements.swapPlayer.innerHTML = available
      .filter(({ index }) => index !== slotIndex)
      .map(({ player, index }) => `<option value="${index}">${escapeHtml(player.position)} · ${escapeHtml(displayPlayerName(player))} #${escapeHtml(player.number)}</option>`).join('');
    const swapping = substitutionMode === 'defense' && defenseMode === 'swap';
    $('#substitution-target-label').textContent = swapping ? '交換球員'
      : substitutionMode === 'offense' && offenseMode === 'batter' ? '被替換打者'
        : substitutionMode === 'offense' ? '被替換跑者' : '換下場球員';
    $('#swap-player-field').hidden = !swapping;
    $('#substitution-target-field').hidden = false;
    $('#incoming-name-field').hidden = swapping;
    $('#incoming-number-field').hidden = swapping;
    form.elements.name.required = !swapping;
  }
  $('#substitution-form').elements.slot.addEventListener('change', updateSubstitutionSlots);
  $('#substitution-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = clone(state);
    const teamIndex = substitutionMode === 'defense' ? fieldingTeamIndex(next) : activeTeamIndex(next);
    const team = next.teams[teamIndex];
    const offenseMode = String(data.get('offenseMode'));
    const selectedSlot = String(data.get('slot'));
    let runnerBaseIndex = -1;
    let slot = selectedSlot;
    if (substitutionMode === 'offense' && offenseMode === 'batter') {
      slot = String(next.orderIndexes[teamIndex]);
    } else if (substitutionMode === 'offense' && offenseMode === 'runner') {
      runnerBaseIndex = Number(selectedSlot.replace('runner:', ''));
      const runner = next.bases[runnerBaseIndex];
      const matchingSlots = team.lineup
        .map((player, index) => ({ player, index }))
        .filter(({ player }) => displayPlayerName(player).trim() === String(runner || '').trim());
      if (!runner || matchingSlots.length !== 1) {
        showToast(matchingSlots.length > 1
          ? '無法辨識同名跑者的打序，請先確認先發名單姓名不重複。'
          : '無法在打序名單中找到該跑者，請先確認先發名單。');
        return;
      }
      slot = String(matchingSlots[0].index);
    }
    const isPitcher = slot === 'pitcher';
    const index = Number(slot);
    if (substitutionMode === 'defense' && data.get('defenseMode') === 'swap') {
      const otherIndex = Number(data.get('swapPlayer'));
      if (index === otherIndex || !team.lineup[index] || !team.lineup[otherIndex]) {
        showToast('請選擇兩位不同的場上球員。');
        return;
      }
      const firstPosition = team.lineup[index].position === 'PH'
        ? team.lineup[index].previousPosition : team.lineup[index].position;
      const secondPosition = team.lineup[otherIndex].position === 'PH'
        ? team.lineup[otherIndex].previousPosition : team.lineup[otherIndex].position;
      team.lineup[index].position = secondPosition;
      team.lineup[otherIndex].position = firstPosition;
      delete team.lineup[index].previousPosition;
      delete team.lineup[otherIndex].previousPosition;
      addRecord(`${team.name}交換守備位置：${team.lineup[index].name} (${secondPosition}) ↔ ${team.lineup[otherIndex].name} (${firstPosition})`, next, 'setup');
      substitutionDialog.close();
      showToast('守備位置交換已記入比賽紀錄。');
      return;
    }
    const outgoing = isPitcher ? team.pitcher : team.lineup[index];
    team.bench.push(outgoing);
    const position = isPitcher ? 'P'
      : outgoing.position === 'PH' ? outgoing.previousPosition || 'DH' : outgoing.position;
    const incoming = {
      id: `SUB-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: String(data.get('name')).trim(),
      number: String(data.get('number')).trim(),
      position: substitutionMode === 'offense' && offenseMode === 'batter' ? 'PH' : position,
      ...(substitutionMode === 'offense' && offenseMode === 'batter' ? { previousPosition: position } : {})
    };
    if (isPitcher) team.pitcher = incoming;
    else team.lineup[index] = incoming;
    if (runnerBaseIndex >= 0) next.bases[runnerBaseIndex] = incoming.name;
    if (substitutionMode === 'offense' && offenseMode === 'batter' && next.batterOverride) {
      next.batter = incoming.name;
    }
    const label = substitutionMode === 'defense'
      ? `${team.name}更換守備 ${position}：${outgoing.name} → ${incoming.name}`
      : offenseMode === 'runner'
        ? `${team.name}更換代跑 ${bases[runnerBaseIndex]}：${outgoing.name} → ${incoming.name}`
        : `${team.name}更換代打 ${index + 1} 棒：${outgoing.name} → ${incoming.name}`;
    addRecord(label, next, 'setup');
    substitutionDialog.close();
    showToast('球員更換已記入比賽紀錄。');
  });

  $('#runner-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const destinations = { ...pendingDestinations, ...Object.fromEntries([...data.entries()]
      .filter(([key]) => key.startsWith('runner-'))
      .map(([key, value]) => {
        const runnerKey = key.replace('runner-', '');
        return [runnerKey === 'batter' ? runnerKey : Number(runnerKey), Number(value)];
      })) };
    const occupied = Object.values(destinations).filter((destination) => destination >= 1 && destination <= 3);
    const hasDuplicateBase = new Set(occupied).size !== occupied.length;
    if (hasDuplicateBase) {
      showRunnerError('同一壘包不能安排兩位跑者，請拖曳或選擇其他壘包。');
      return;
    }
    const fixedOut = batterIsFixedOut() ? 1 : 0;
    const runnerOuts = Object.entries(destinations)
      .filter(([key, destination]) => (!fixedOut || key !== 'batter') && destination === 0).length;
    if (state.outs + fixedOut + runnerOuts > 3) {
      showRunnerError('本次結果不能超過該局剩餘出局數。');
      return;
    }
    if (pendingHit === 'error' && destinations.batter === 0) {
      showRunnerError('失誤上壘時，打者不能記為出局。');
      return;
    }
    if (pendingHit === 'fielder-choice'
      && !Object.entries(destinations).some(([key, destination]) => key !== 'batter' && destination === 0)) {
      showRunnerError('野手選擇至少要有一位跑者出局。');
      return;
    }
    if (['out', 'force-out'].includes(pendingHit)
      && destinations.batter !== 0) {
      showRunnerError('接殺出局或封殺出局時，跑者只能留在原壘或出局。');
      return;
    }
    clearRunnerError();
    $('#runner-dialog').close();
    applyPlay(pendingHit, destinations);
  });

  const stealDialog = $('#steal-dialog');
  function openRunnerEventDialog(eventType) {
    runnerEvent = eventType;
    const runnerSelect = $('#steal-form').elements.runner;
    runnerSelect.innerHTML = state.bases.map((runner, index) => runner
      ? `<option value="${index}">${bases[index]} · ${escapeHtml(runner)}</option>` : '').join('');
    if (!state.bases.some(Boolean)) { showToast('目前壘上沒有跑者。'); return; }
    const pickoff = eventType === 'pickoff';
    $('#steal-dialog h2').textContent = pickoff ? '記錄牽制出局' : '記錄盜壘成功';
    $('#runner-event-submit').textContent = pickoff ? '記錄牽制出局' : '記錄盜壘成功';
    stealDialog.showModal();
  }
  $('#steal-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const baseIndex = Number(data.get('runner'));
    const runner = state.bases[baseIndex];
    if (!runner) {
      showToast('所選壘包上已沒有跑者，請重新選擇。');
      stealDialog.close();
      return;
    }
    const next = clone(state);
    if (runnerEvent === 'pickoff') {
      next.bases[baseIndex] = null;
      next.outs += 1;
      const result = next.outs >= 3;
      if (result) advanceHalfInning(next);
      addRecord(`牽制出局：${runner} 出局`, next);
    } else {
      const destination = baseIndex + 1;
      if (destination > 2) {
        next.bases[baseIndex] = null;
        scoreRun(next, activeTeamIndex(next));
      } else if (next.bases[destination]) {
        showToast('目標壘包已有跑者，請先處理跑者位置。');
        return;
      } else {
        next.bases[destination] = runner;
        next.bases[baseIndex] = null;
      }
      addRecord(`盜壘成功：${runner}${destination > 2 ? '回本壘得分' : `進佔${bases[destination]}`}`, next);
    }
    stealDialog.close();
  });

  document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
  $('#export-button').addEventListener('click', () => {
    const rosters = [];
    const rosterIndexes = new Map();
    const compactRecords = records.map((record) => {
      const compactState = clone(record.state);
      compactState.teams = compactState.teams.map((team) => {
        const roster = { lineup: team.lineup, pitcher: team.pitcher, bench: team.bench };
        const rosterKey = JSON.stringify(roster);
        let rosterRef = rosterIndexes.get(rosterKey);
        if (rosterRef === undefined) {
          rosterRef = rosters.length;
          rosterIndexes.set(rosterKey, rosterRef);
          rosters.push(roster);
        }
        const { lineup, pitcher, bench, ...teamState } = team;
        return { ...teamState, rosterRef };
      });
      return { ...record, state: compactState };
    });
    const payload = JSON.stringify({ format: 'ballpark-scoreboard-v2', rosters, records: compactRecords, cursor });
    const blob = new Blob([payload], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const filename = (String(state.gameInfo || '').trim() || '逐球紀錄').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
    link.download = `${filename}.txt`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('已匯出逐球紀錄文字檔。');
  });
  $('#import-button').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('檔案超過 5 MB，無法匯入。');
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.records) || !Number.isInteger(data.cursor)
        || data.cursor < 0 || data.cursor > data.records.length) throw new Error('檔案不是有效的逐球紀錄。');
      const imported = data.records.map((record) => {
        if (!record || !record.state || typeof record.label !== 'string') throw new Error('逐球紀錄內容不完整。');
        let stateToMigrate = record.state;
        if (data.format === 'ballpark-scoreboard-v2') {
          if (!Array.isArray(data.rosters) || !Array.isArray(record.state.teams)) {
            throw new Error('逐球紀錄中的球員名單資料不完整。');
          }
          stateToMigrate = {
            ...record.state,
            teams: record.state.teams.map((team) => {
              if (!team || !Number.isInteger(team.rosterRef)
                || team.rosterRef < 0 || team.rosterRef >= data.rosters.length) {
                throw new Error('逐球紀錄包含無效的球員名單參照。');
              }
              const roster = data.rosters[team.rosterRef];
              if (!roster || !Array.isArray(roster.lineup) || !roster.pitcher || !Array.isArray(roster.bench)) {
                throw new Error('逐球紀錄中的球員名單格式不正確。');
              }
              const { rosterRef, ...teamState } = team;
              return { ...teamState, ...roster };
            })
          };
        }
        return { ...record, state: migrateState(stateToMigrate) };
      });
      replay(imported, imported.length);
      records = imported;
      cursor = data.cursor;
      state = cursor ? replay(records, cursor) : defaultState();
      selectedInning = 0;
      selectedHalf = 'top';
      saveAndRender();
      showToast(`已匯入 ${records.length} 筆逐球紀錄。`);
    } catch (error) {
      console.error('匯入逐球紀錄失敗。', error);
      showToast(error instanceof Error ? error.message : '匯入失敗，請檢查文字檔格式。');
    } finally {
      event.target.value = '';
    }
  });

  readSavedGame();
  render();
})();
