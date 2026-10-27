(() => {
  const STORAGE_KEY = 'ballpark-scoreboard-v5';
  const positions = [
    ['P', '投手'], ['C', '捕手'], ['1B', '一壘手'], ['2B', '二壘手'], ['3B', '三壘手'],
    ['SS', '游擊手'], ['LF', '左外野手'], ['CF', '中外野手'], ['RF', '右外野手'], ['DH', '指定打擊']
  ];
  const lineupPositions = positions.filter(([code]) => code !== 'P');
  const bases = ['一壘', '二壘', '三壘'];
  const playLabels = {
    'swinging-strike': '揮棒落空', 'called-strike': '好球未揮棒', ball: '壞球',
    'foul-tip': '擦棒被捕', 'uncaught-third-strike': '不死三振',
    hbp: '觸身球', foul: '界外球', out: '接殺出局',
    single: '一壘安打', double: '二壘安打', triple: '三壘安打',
    'home-run': '全壘打', error: '守備失誤', 'fielder-choice': '野手選擇',
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
    batterPitchCount: 0,
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

  function validateRecords(source) {
    for (const record of source) {
      if (!record || typeof record.type !== 'string' || typeof record.code !== 'string') {
        throw new Error('逐球紀錄內容不完整。');
      }
    }
    return source;
  }

  async function loadVersion() {
    const versionElement = $('#app-version');
    try {
      const response = await fetch('version.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (typeof data.version !== 'string' || !data.version.trim()) {
        throw new Error('version.json 缺少有效的 version 字串。');
      }
      versionElement.textContent = data.version.trim();
    } catch {
      versionElement.textContent = '';
    }
  }

  function replay(allRecords, through = allRecords.length) {
    let replayed = defaultState();
    for (const event of allRecords.slice(0, through)) {
      if (!event) throw new Error('逐球紀錄包含無效資料');
      replayed = applyEvent(replayed, event);
    }
    return replayed;
  }
  function statesAfterRecords(allRecords, through) {
    let current = defaultState();
    return allRecords.slice(0, through).map((event) => {
      const previous = { ...current };
      delete previous._endingBases;
      current = applyEvent(previous, event);
      return current;
    });
  }

  function readSavedGame() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const data = JSON.parse(saved);
      if (data.format !== 'ballpark-scoreboard-v5'
        || !Array.isArray(data.records) || !Number.isInteger(data.cursor)) {
        throw new Error('存檔資料格式不正確');
      }
      records = validateRecords(data.records);
      cursor = Math.max(0, Math.min(data.cursor, records.length));
      state = cursor ? replay(records, cursor) : defaultState();
    } catch (error) {
      console.error('無法讀取已儲存的逐球紀錄。', error);
      localStorage.removeItem(STORAGE_KEY);
      records = [];
      cursor = 0;
      state = defaultState();
      showToast('無法讀取先前紀錄，已開始新比賽。');
    }
  }

  function saveAndRender() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ format: 'ballpark-scoreboard-v5', records, cursor }));
    } catch (error) {
      console.error('無法儲存逐球紀錄。', error);
      showToast('儲存失敗，請檢查瀏覽器儲存空間。');
    }
    render();
  }

  function addRecord(event) {
    const previous = state;
    const nextState = applyEvent(previous, event);
    if (nextState === previous) return;
    const updatedRecords = records.slice();
    updatedRecords.splice(cursor, 0, clone(event));
    try {
      replay(updatedRecords);
    } catch (error) {
      console.error('無法套用新增紀錄後的後續事件。', error);
      showToast(error instanceof Error
        ? `無法新增紀錄，因為後續事件無法套用：${error.message}`
        : '無法新增紀錄，因為後續事件無法套用。');
      return;
    }
    records = updatedRecords;
    cursor += 1;
    state = nextState;
    const location = event.type === 'setup' && event.code === 'set-game-state' ? nextState : previous;
    selectedInning = location.inning;
    selectedHalf = location.half;
    saveAndRender();
    const recordList = $('#record-list');
    recordList.scrollTop = recordList.scrollHeight;
  }

  function nextBatter(gameState) {
    gameState.batterPitchCount = 0;
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
    const fieldingTeam = activeTeamIndex(gameState);
    gameState._endingBases = [...gameState.bases];
    gameState.batterPitchCount = 0;
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
    gameState.teams[fieldingTeam].lineup.forEach((player) => {
      if ((player.position === 'PH' || player.position === 'PR') && player.previousPosition) {
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
  function forceOutResult(gameState, destinations = {}) {
    if (destinations.batter === 1) return null;
    const forcedBases = [
      Boolean(gameState.bases[0]),
      Boolean(gameState.bases[0] && gameState.bases[1]),
      Boolean(gameState.bases[0] && gameState.bases[1] && gameState.bases[2])
    ];
    const forcedRunnerOuts = forcedBases.filter((forced, base) =>
      forced && destinations[base] === 0).length;
    if (!forcedRunnerOuts) return null;
    const runnerOuts = Object.entries(destinations)
      .filter(([key, destination]) => key !== 'batter' && destination === 0).length;
    const outsOnPlay = runnerOuts + 1;
    if (outsOnPlay >= 3) return '三殺';
    if (outsOnPlay >= 2) return '雙殺';
    return null;
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
    gameState.batterPitchCount += 1;
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
    addRecord({ type: 'play', code: play, ...(runnerDestinations ? { runnerDestinations } : {}) });
  }
  function applyPlayState(gameState, play, runnerDestinations) {
    if (gameState.gameOver) return gameState;
    const next = clone(gameState);
    const offense = activeTeamIndex(next);
    const defense = fieldingTeamIndex(next);
    const batter = batterName(next);
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
      }
    } else if (play === 'uncaught-third-strike') {
      next.strikes += 1;
      recordAppearance(next, activeBatter(next), '不死三振');
      awardWalk(next, offense);
      clearCount(next);
      nextBatter(next);
    } else if (play === 'hbp' || play === 'intentional-walk') {
      if (play === 'hbp') next.balls += 1;
      recordAppearance(next, activeBatter(next), play === 'hbp' ? '觸身球保送' : '故意四壞');
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
      recordAppearance(next, activeBatter(next),
        forceOutResult(gameState, runnerDestinations) || '封殺出局');
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
      if (!hitBases) return gameState;
      next.teams[offense].hits += 1;
      recordAppearance(next, activeBatter(next), playLabels[play]);
      const runnerOuts = Object.values(runnerDestinations || {}).filter((destination) => destination === 0).length;
      advanceHitRunners(next, hitBases, batter, offense, runnerDestinations);
      clearCount(next);
      nextBatter(next);
      if (runnerOuts) recordRunnerOuts(next, runnerOuts);
    }
    return next;
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

  function applyEvent(previous, event) {
    if (!event || typeof event.type !== 'string' || typeof event.code !== 'string') {
      throw new Error('逐球紀錄包含無效事件。');
    }
    if (event.type === 'play') {
      if (!Object.hasOwn(playLabels, event.code)) throw new Error(`不支援的比賽事件：${event.code}`);
      return applyPlayState(previous, event.code, event.runnerDestinations);
    }
    if (event.type === 'runner') {
      const next = clone(previous);
      if (event.code === 'steal') {
        if (!Number.isInteger(event.from) || event.from < 0 || event.from > 2
          || !Number.isInteger(event.to) || event.to !== event.from + 1 || !next.bases[event.from]) {
          throw new Error('逐球紀錄包含無效盜壘事件。');
        }
        if (event.to > 2) {
          next.bases[event.from] = null;
          scoreRun(next, activeTeamIndex(next));
        } else {
          if (next.bases[event.to]) throw new Error('盜壘事件的目標壘包已有跑者。');
          next.bases[event.to] = next.bases[event.from];
          next.bases[event.from] = null;
        }
      } else if (event.code === 'pickoff') {
        if (!Number.isInteger(event.base) || event.base < 0 || event.base > 2 || !next.bases[event.base]) {
          throw new Error('逐球紀錄包含無效牽制事件。');
        }
        next.bases[event.base] = null;
        next.outs += 1;
        if (next.outs >= 3) advanceHalfInning(next);
      } else {
        throw new Error(`不支援的跑壘事件：${event.code}`);
      }
      return next;
    }
    if (event.type === 'setup' && event.code === 'set-roster') {
      if (!Array.isArray(event.teams) || event.teams.length !== 2) throw new Error('名單設定事件格式不正確。');
      const next = clone(previous);
      next.teams = next.teams.map((team, index) => ({
        ...team,
        name: event.teams[index].name,
        lineup: clone(event.teams[index].lineup),
        pitcher: clone(event.teams[index].pitcher)
      }));
      next.gameInfo = event.gameInfo;
      if (!next.batterOverride) next.batter = batterName(next);
      return next;
    }
    if (event.type === 'setup' && event.code === 'set-game-state') {
      const next = clone(previous);
      next.balls = event.balls;
      next.strikes = event.strikes;
      next.outs = event.outs;
      next.bases = clone(event.bases);
      next.inning = event.inning;
      next.half = event.half;
      next.teams.forEach((team, index) => {
        team.innings = clone(event.teams[index].innings);
        team.hits = event.teams[index].hits;
        team.errors = event.teams[index].errors;
      });
      next.gameOver = false;
      next.walkOff = false;
      const battingTeam = activeTeamIndex(next);
      next.orderIndexes[battingTeam] = event.batterIndex;
      next.batterNumber = event.batterIndex + 1;
      next.batter = next.teams[battingTeam].lineup[event.batterIndex].name;
      if (previous.batterOverride || battingTeam !== activeTeamIndex(previous)
        || event.batterIndex !== previous.orderIndexes[battingTeam]) next.batterPitchCount = 0;
      next.batterOverride = false;
      return next;
    }
    if (event.type === 'substitution') {
      const next = clone(previous);
      const team = next.teams[event.teamIndex];
      if (!team) throw new Error('球員異動事件的球隊無效。');
      if (event.code === 'swap-defense') {
        const [firstIndex, secondIndex] = event.slots || [];
        const first = team.lineup[firstIndex];
        const second = team.lineup[secondIndex];
        if (!first || !second) throw new Error('守備位置交換事件的棒次無效。');
        const firstPosition = first.position === 'PH' ? first.previousPosition : first.position;
        const secondPosition = second.position === 'PH' ? second.previousPosition : second.position;
        first.position = secondPosition;
        second.position = firstPosition;
        delete first.previousPosition;
        delete second.previousPosition;
        return next;
      }
      const incoming = clone(event.player);
      const outgoing = event.slot === 'pitcher' ? team.pitcher : team.lineup[event.slot];
      if (!outgoing || !incoming) throw new Error('球員異動事件資料不完整。');
      team.bench.push(outgoing);
      if (event.slot === 'pitcher') team.pitcher = incoming;
      else team.lineup[event.slot] = incoming;
      if (event.base !== undefined) next.bases[event.base] = incoming.name;
      if (event.code === 'batter' && next.batterOverride) next.batter = incoming.name;
      return next;
    }
    throw new Error(`不支援的事件類型：${event.type}/${event.code}`);
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
    const substitutionOptions = ['PH', 'PR'].includes(selected)
      ? `<option value="${selected}" selected>${selected} ${selected === 'PH' ? '代打' : '代跑'}</option>` : '';
    return substitutionOptions + lineupPositions.map(([code, name]) => `<option value="${code}" ${selected === code ? 'selected' : ''}>${code} ${name}</option>`).join('');
  }
  function currentHalfRecords() {
    const stateAfter = statesAfterRecords(records, records.length);
    const entries = records.map((record, index) => {
      const stateBefore = index ? stateAfter[index - 1] : defaultState();
      const eventState = record.type === 'setup' && record.code === 'set-game-state'
        ? stateAfter[index] : stateBefore;
      return { record, index, stateBefore, stateAfter: stateAfter[index], inning: eventState.inning, half: eventState.half };
    });
    const innings = [...new Set([...entries.map((entry) => entry.inning), state.inning])]
      .sort((first, second) => first - second);
    return { entries, innings };
  }
  function returnToLatestRecord() {
    cursor = records.length;
    state = cursor ? replay(records, cursor) : defaultState();
    const latestEntry = currentHalfRecords().entries.at(-1);
    selectedInning = latestEntry?.inning ?? state.inning;
    selectedHalf = latestEntry?.half ?? state.half;
    saveAndRender();
    if (cursor) {
      $('#record-list').querySelector(`[data-record-index="${cursor - 1}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    }
  }
  function describeEvent(event, before, after) {
    if (event.type === 'play') {
      const batterAdvanced = after.orderIndexes[activeTeamIndex(before)] !== before.orderIndexes[activeTeamIndex(before)];
      if (event.code === 'ball' && batterAdvanced) return '四壞保送';
      if (event.code === 'force-out') {
        const forceResult = forceOutResult(before, event.runnerDestinations);
        if (forceResult) return forceResult;
      }
      const label = playLabels[event.code] || event.code;
      return event.code === 'uncaught-third-strike' || event.code === 'swinging-strike'
        || event.code === 'called-strike' || event.code === 'foul-tip'
        ? (event.code === 'uncaught-third-strike' || after.orderIndexes[activeTeamIndex(before)] !== before.orderIndexes[activeTeamIndex(before)]
          ? `K ${label}` : label)
        : label;
    }
    if (event.type === 'runner' && event.code === 'steal') {
      const runner = before.bases[event.from];
      return `盜壘成功：${runner}${event.to > 2 ? '回本壘得分' : `進佔${bases[event.to]}`}`;
    }
    if (event.type === 'runner' && event.code === 'pickoff') return `牽制出局：${before.bases[event.base]} 出局`;
    if (event.type === 'setup' && event.code === 'set-roster') return '更新比賽資訊與先發名單';
    if (event.type === 'setup' && event.code === 'set-game-state') return '直接設定比賽狀態';
    if (event.type === 'substitution' && event.code === 'swap-defense') {
      return `交換守備位置：${after.teams[event.teamIndex].lineup[event.slots[0]].name}`
        + ` (${after.teams[event.teamIndex].lineup[event.slots[0]].position}) ↔ `
        + `${after.teams[event.teamIndex].lineup[event.slots[1]].name}`
        + ` (${after.teams[event.teamIndex].lineup[event.slots[1]].position})`;
    }
    if (event.type === 'substitution') {
      const teamBefore = before.teams[event.teamIndex];
      const outgoing = event.slot === 'pitcher' ? teamBefore.pitcher : teamBefore.lineup[event.slot];
      const position = event.player.position === 'PH' ? event.player.previousPosition || 'DH' : event.player.position;
      const verb = event.code === 'defense' ? `更換守備 ${position}`
        : event.code === 'runner' ? `更換代跑 ${bases[event.base]}`
          : `更換代打 ${Number(event.slot) + 1} 棒`;
      return `${verb}：${outgoing.name} → ${event.player.name}`;
    }
    return event.code;
  }
  function runsBattedIn(event, before, after) {
    if (event.type !== 'play'
      || !['single', 'double', 'triple', 'home-run', 'out', 'sacrifice', 'fielder-choice'].includes(event.code)) {
      return 0;
    }
    const offense = activeTeamIndex(before);
    return Math.max(0, teamRuns(after.teams[offense]) - teamRuns(before.teams[offense]));
  }
  function historyCount(event, before, after) {
    const battingTeam = activeTeamIndex(before);
    const plateAppearanceEnded = event.type === 'play' && (
      before.orderIndexes[battingTeam] !== after.orderIndexes[battingTeam]
      || before.inning !== after.inning
      || before.half !== after.half
    );
    if (!plateAppearanceEnded) return `${after.balls}-${after.strikes}`;

    let { balls, strikes } = before;
    if (event.code === 'ball' || event.code === 'timeout-ball' || event.code === 'hbp') balls += 1;
    else if (event.code === 'foul') strikes = Math.min(strikes + 1, 2);
    else if (['swinging-strike', 'foul-tip', 'called-strike', 'timeout-strike', 'uncaught-third-strike'].includes(event.code)) {
      strikes += 1;
    }
    return `${balls}-${strikes}`;
  }
  function renderHistory() {
    const { entries, innings } = currentHalfRecords();
    if (!innings.includes(selectedInning)) selectedInning = state.inning;
    if (!innings.includes(selectedInning)) selectedInning = innings[innings.length - 1];
    $('#record-total').textContent = records.length;
    $('#history-inning-label').textContent = `第 ${selectedInning} 局`;
    $('#previous-inning').disabled = selectedInning <= innings[0];
    $('#next-inning').disabled = selectedInning >= innings[innings.length - 1];
    $('#half-tabs').innerHTML = ['top', 'bottom'].map((half) => {
      const count = entries.filter((entry) => entry.inning === selectedInning && entry.half === half).length;
      return `<button type="button" role="tab" aria-selected="${half === selectedHalf}" class="half-tab ${half === selectedHalf ? 'selected' : ''}" data-half="${half}">${half === 'top' ? '上半局' : '下半局'} <span>${count}</span></button>`;
    }).join('');
    document.querySelectorAll('[data-half]').forEach((button) => button.addEventListener('click', () => {
      selectedHalf = button.dataset.half;
      renderHistory();
    }));
    const visibleRecords = entries.filter((entry) => entry.inning === selectedInning && entry.half === selectedHalf);
    $('#record-list').innerHTML = visibleRecords.map(({ record, index, stateBefore, stateAfter, inning, half }) => {
      const position = index + 1;
      const lineupUpdate = record.code === 'set-roster';
      const label = describeEvent(record, stateBefore, stateAfter);
      const isCurrent = cursor === index + 1;
      const peopleState = record.type === 'substitution' ? stateAfter : stateBefore;
      const batter = activeBatter(peopleState);
      const batterOrder = (peopleState.orderIndexes?.[activeTeamIndex(peopleState)] ?? 0) + 1;
      const pitcherForDisplay = currentPitcher(peopleState);
      const pitchNumber = pitcherForDisplay
        && (stateAfter.pitcherCounts[pitcherForDisplay.id] || 0) > (stateBefore.pitcherCounts[pitcherForDisplay.id] || 0)
        ? stateAfter.pitcherCounts[pitcherForDisplay.id] : null;
      const pitcherName = String(pitcherForDisplay?.name || '').trim();
      const pitcher = pitcherForDisplay
        ? `投手 ${pitcherName || '球員'} #${pitcherForDisplay.number}${pitchNumber ? ` 第${pitchNumber}球` : ''}` : '';
      const batterLabel = `${batterOrder}棒 ${displayPlayerName(batter)} #${batter.number} ${batter.position}`;
      const people = lineupUpdate ? '' : [batterLabel, pitcher].filter(Boolean)
        .map((person) => `<span>${escapeHtml(person)}</span>`).join('') || '<span>比賽狀態設定</span>';
      const halfEnded = Boolean(stateAfter._endingBases)
        || stateBefore.inning !== stateAfter.inning || stateBefore.half !== stateAfter.half;
      const recordBases = stateAfter._endingBases || stateAfter.bases;
      const runnerStatus = recordBases.map((runner, baseIndex) =>
        runner ? `${bases[baseIndex]} ${runner}` : '').filter(Boolean);
      const outs = halfEnded ? 3 : stateAfter.outs;
      const runnerSummary = outs >= 3
        ? (runnerStatus.length ? `殘壘：${runnerStatus.join('、')}` : '無殘壘')
        : (runnerStatus.length ? runnerStatus.join('、') : '壘上無人');
      const runnerDetails = lineupUpdate ? '' : `<span class="record-runners">${escapeHtml(runnerSummary)}</span>`;
      const count = historyCount(record, stateBefore, stateAfter);
      const rbi = runsBattedIn(record, stateBefore, stateAfter);
      const rbiDetails = rbi ? `<span class="record-rbi">${rbi} 分打點</span>` : '';
      return `<li class="record-item ${index >= cursor ? 'future' : ''}"><button class="record-entry ${isCurrent ? 'active' : ''}" type="button" data-record-index="${index}" data-record-inning="${inning}" data-record-half="${half}" aria-label="回到第 ${position} 筆紀錄：${escapeHtml(label)}${rbi ? `，${rbi} 分打點` : ''}"${isCurrent ? ' aria-current="step"' : ''}><span class="record-number">${String(position).padStart(2, '0')}</span><span class="record-content"><span class="record-label">${escapeHtml(label)}</span>${rbiDetails}${people ? `<span class="record-people">${people}</span>` : ''}${runnerDetails}</span><span class="record-meta">${count} · ${outs} 出局</span></button></li>`;
    }).join('');
    const stateHelp = cursor < records.length
      ? '目前為歷史狀態；新增紀錄會保留並接續後續紀錄。'
      : '點選紀錄可回到當下狀態。';
    $('#history-help').textContent = `顯示 ${halfLabel(selectedInning, selectedHalf)}；${stateHelp}`;
  }

  function render() {
    renderScoreboard();
    renderLineup();
    const gameLayout = $('.game-layout');
    gameLayout.classList.toggle('game-over', state.gameOver);
    document.body.classList.toggle('game-over', state.gameOver);
    $('.count-panel').hidden = state.gameOver;
    $('.actions-panel').hidden = state.gameOver;
    updateGameOverHistoryHeight();
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
    document.querySelectorAll('[data-play]').forEach((button) => { button.disabled = false; });
    document.querySelector('[data-play="sacrifice"]').disabled = state.outs >= 2 || !state.bases.some(Boolean);
    document.querySelector('[data-play="fielder-choice"]').disabled = !state.bases.some(Boolean);
    document.querySelector('[data-play="uncaught-third-strike"]').disabled = state.strikes !== 2 || state.outs < 2 && Boolean(state.bases[0]);
    $('#ball-dots').innerHTML = Array.from({ length: 3 }, (_, i) => `<span class="count-dot ball ${i < state.balls ? 'active' : ''}"></span>`).join('');
    $('#strike-dots').innerHTML = Array.from({ length: 2 }, (_, i) => `<span class="count-dot strike ${i < state.strikes ? 'active' : ''}"></span>`).join('');
    $('#out-lights').innerHTML = Array.from({ length: 2 }, (_, i) => `<span class="out-light ${i < state.outs ? 'active' : ''}"></span>`).join('');
    const hasRunners = state.bases.some(Boolean);
    document.querySelector('[data-play="steal"]').disabled = !hasRunners;
    document.querySelector('[data-play="pickoff"]').disabled = !hasRunners;
    const pitcher = currentPitcher();
    $('#at-bat-pitch-count').textContent = state.batterPitchCount;
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
    ...fielding.lineup.map((player) => ['PH', 'PR'].includes(player.position) && player.previousPosition
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
    $('#return-latest-button').disabled = cursor === records.length;
    $('#delete-current-button').disabled = cursor === 0;
    renderHistory();
  }

  function updateGameOverHistoryHeight() {
    const gameLayout = $('.game-layout');
    if (!state.gameOver) {
      gameLayout.style.removeProperty('--game-over-history-height');
      return;
    }
    const historyTop = $('.history-panel').getBoundingClientRect().top;
    const bottomGap = 16;
    const availableHeight = Math.max(0, window.innerHeight - historyTop - bottomGap);
    gameLayout.style.setProperty('--game-over-history-height', `${availableHeight}px`);
  }

  function calculateGameStats() {
    const initial = defaultState();
    const battingRows = initial.teams.map((team) => team.lineup.map((player, order) => ({
      order,
      players: [player],
      stats: new Map()
    })));
    const battingPlayers = new Map();
    const pitchingRows = initial.teams.map(() => []);
    const pitchingPlayers = new Map();
    const pitchingLine = () => ({ outs: 0, batters: 0, strikes: 0, pitches: 0, strikeouts: 0, hits: 0, walks: 0, hbp: 0, runs: 0 });
    const playerKey = (teamIndex, player) => `${teamIndex}:${player.id}`;
    const ensureBatter = (teamIndex, order, player) => {
      const row = battingRows[teamIndex][order];
      let participant = row.players.find((candidate) => candidate.id === player.id);
      if (!participant) {
        participant = player;
        row.players.push(participant);
      } else {
        Object.assign(participant, player);
      }
      const key = playerKey(teamIndex, participant);
      if (!battingPlayers.has(key)) battingPlayers.set(key, statLine());
      row.stats.set(key, battingPlayers.get(key));
      return battingPlayers.get(key);
    };
    const ensurePitcher = (teamIndex, player) => {
      if (!player) return null;
      const key = playerKey(teamIndex, player);
      if (!pitchingPlayers.has(key)) {
        const stat = pitchingLine();
        pitchingPlayers.set(key, stat);
        pitchingRows[teamIndex].push({ ...player, stat });
      }
      return pitchingPlayers.get(key);
    };
    initial.teams.forEach((team, teamIndex) => {
      team.lineup.forEach((player, order) => ensureBatter(teamIndex, order, player));
      ensurePitcher(teamIndex, team.pitcher);
    });

    const stateAfter = statesAfterRecords(records, cursor);
    records.slice(0, cursor).forEach((event, index) => {
      const before = index ? stateAfter[index - 1] : initial;
      const after = stateAfter[index];
      if (event.type === 'setup' && event.code === 'set-roster') {
        event.teams.forEach((team, teamIndex) => {
          team.lineup.forEach((player, order) => {
            const row = battingRows[teamIndex][order];
            const existing = row.players.find((candidate) => candidate.id === player.id);
            if (existing) Object.assign(existing, player);
            else if (row.players.length === 1 && !battingPlayers.has(playerKey(teamIndex, row.players[0]))) {
              row.players[0] = player;
              ensureBatter(teamIndex, order, player);
            }
          });
          const pitcher = team.pitcher;
          const existingPitcher = pitchingRows[teamIndex].find((candidate) => candidate.id === pitcher.id);
          if (existingPitcher) Object.assign(existingPitcher, pitcher);
          else ensurePitcher(teamIndex, pitcher);
        });
      }

      const battingTeam = activeTeamIndex(before);
      const battingOrder = before.orderIndexes[battingTeam];
      const substitutedOrder = Number(event.slot);
      if (event.type === 'substitution' && event.code === 'batter'
        && Number.isInteger(substitutedOrder) && substitutedOrder >= 0 && substitutedOrder < 9 && event.player) {
        ensureBatter(event.teamIndex, substitutedOrder, event.player);
      }
      const plateAppearanceEnded = event.type === 'play' && (
        before.orderIndexes[battingTeam] !== after.orderIndexes[battingTeam]
        || before.inning !== after.inning || before.half !== after.half
      );
      if (plateAppearanceEnded) {
        const batter = activeBatter(before);
        const batterStats = ensureBatter(battingTeam, battingOrder, batter);
        batterStats.appearances += 1;
        if (['single', 'double', 'triple', 'home-run'].includes(event.code)) batterStats.hits += 1;
        if (event.code === 'sacrifice') batterStats.sacrifices += 1;
        if (['ball', 'timeout-ball'].includes(event.code) && before.balls === 3
          || event.code === 'intentional-walk') batterStats.walks += 1;
        if (event.code === 'hbp') batterStats.hbp += 1;
        if (event.code === 'uncaught-third-strike'
          || ['swinging-strike', 'called-strike', 'foul-tip', 'timeout-strike'].includes(event.code)) {
          batterStats.strikeouts += 1;
        }
        const runsScored = Math.max(0, teamRuns(after.teams[battingTeam]) - teamRuns(before.teams[battingTeam]));
        const isWalkOrHitByPitch = (['ball', 'timeout-ball'].includes(event.code) && before.balls === 3)
          || event.code === 'intentional-walk' || event.code === 'hbp';
        batterStats.rbi += runsBattedIn(event, before, after) + (isWalkOrHitByPitch ? runsScored : 0);
      }

      if (event.type === 'runner') {
        const baseIndex = event.code === 'steal' ? event.from : event.base;
        const runnerName = before.bases[baseIndex];
        const runner = before.teams[battingTeam].lineup.find((player) => displayPlayerName(player) === runnerName);
        if (runner) {
          const runnerStats = ensureBatter(battingTeam,
            before.teams[battingTeam].lineup.findIndex((player) => player.id === runner.id), runner);
          if (event.code === 'steal') runnerStats.steals += 1;
          if (event.code === 'pickoff') runnerStats.pickoffs += 1;
        }
      }

      const pitcherTeam = fieldingTeamIndex(before);
      const pitcher = currentPitcher(before);
      const runsAllowed = ['play', 'runner'].includes(event.type)
        ? Math.max(0, teamRuns(after.teams[battingTeam]) - teamRuns(before.teams[battingTeam])) : 0;
      const strikePitches = [
        'swinging-strike', 'called-strike', 'foul-tip', 'foul', 'uncaught-third-strike',
        'out', 'force-out', 'fielder-choice', 'single', 'double', 'triple', 'home-run', 'error', 'sacrifice'
      ];
      const pitchingEvent = event.type === 'play'
        && (actualPitch(event.code) || plateAppearanceEnded || runsAllowed > 0);
      const pickoffEvent = event.type === 'runner' && event.code === 'pickoff';
      if (pitchingEvent || pickoffEvent || runsAllowed > 0) {
        const pitcherStats = ensurePitcher(pitcherTeam, pitcher);
        if (pitcherStats) {
          if (pitchingEvent && actualPitch(event.code)) {
            pitcherStats.pitches += 1;
            if (strikePitches.includes(event.code)) pitcherStats.strikes += 1;
          }
          if (plateAppearanceEnded) pitcherStats.batters += 1;
          if (plateAppearanceEnded && (event.code === 'uncaught-third-strike'
            || ['swinging-strike', 'called-strike', 'foul-tip', 'timeout-strike'].includes(event.code))) {
            pitcherStats.strikeouts += 1;
          }
          if (plateAppearanceEnded && ['single', 'double', 'triple', 'home-run'].includes(event.code)) pitcherStats.hits += 1;
          if (plateAppearanceEnded && (['ball', 'timeout-ball'].includes(event.code) && before.balls === 3
            || event.code === 'intentional-walk')) pitcherStats.walks += 1;
          if (plateAppearanceEnded && event.code === 'hbp') pitcherStats.hbp += 1;
          pitcherStats.runs += runsAllowed;
          const outsRecorded = after._endingBases
            ? Math.max(0, 3 - before.outs)
            : Math.max(0, after.outs - before.outs);
          pitcherStats.outs += outsRecorded;
        }
      }

      if (event.type === 'substitution' && event.slot === 'pitcher' && event.player) {
        ensurePitcher(event.teamIndex, event.player);
      }
    });
    return { battingRows, pitchingRows };
  }

  let statsDialogType = 'batting';
  let statsTeamIndex = 0;
  function renderStatsDialog() {
    const playerKey = (teamIndex, player) => `${teamIndex}:${player.id}`;
    const { battingRows, pitchingRows } = calculateGameStats();
    const team = state.teams[statsTeamIndex];
    const title = statsDialogType === 'batting' ? '打擊成績' : '投手成績';
    $('#stats-dialog-title').textContent = `${title} · ${team.name}`;
    $('#stats-team-switcher').innerHTML = state.teams.map((candidate, index) =>
      `<button class="button button-quiet stats-team-button" type="button" data-stats-team="${index}" aria-pressed="${index === statsTeamIndex}">${escapeHtml(candidate.name)}</button>`
    ).join('');

    if (statsDialogType === 'batting') {
      const headers = ['棒次', '姓名', '打席', '安打', '犧牲打', '打點', '四壞', '觸身', '被三振', '盜壘', '牽制出局'];
      const rows = battingRows[statsTeamIndex].flatMap((row) => row.players.map((player, participantIndex) => {
        const stats = row.stats.get(playerKey(statsTeamIndex, player)) || statLine();
        const values = [stats.appearances, stats.hits, stats.sacrifices, stats.rbi, stats.walks, stats.hbp,
          stats.strikeouts, stats.steals, stats.pickoffs];
        return `<tr class="${participantIndex ? 'stats-substitute-row' : ''}"><td class="stats-order">${participantIndex ? '' : `${row.order + 1}棒`}</td><td class="stats-player">${escapeHtml(displayPlayerName(player))}${player.number ? ` <small>#${escapeHtml(player.number)}</small>` : ''}</td>${values.map((value) => `<td>${value}</td>`).join('')}</tr>`;
      })).join('');
      $('#stats-table-container').innerHTML = `<table class="stats-table" aria-label="${escapeHtml(team.name)}打擊成績"><thead><tr>${headers.map((header, index) => `<th${index === 1 ? ' class="stats-player"' : ''}>${header}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
      return;
    }

    const headers = ['投手', '局數', '打席', '好球／球數', '奪三振', '安打', '四壞', '觸身', '失分'];
    const rows = pitchingRows[statsTeamIndex].map((pitcher) => {
      const stats = pitcher.stat || pitchingPlayersStat(pitcher);
      const innings = stats.outs % 3
        ? `${Math.floor(stats.outs / 3)}.${stats.outs % 3}`
        : String(Math.floor(stats.outs / 3));
      return `<tr><td class="stats-player stats-pitcher-name">${escapeHtml(displayPlayerName(pitcher))}${pitcher.number ? ` <small>#${escapeHtml(pitcher.number)}</small>` : ''}</td><td>${innings}</td><td>${stats.batters}</td><td>${stats.strikes}／${stats.pitches}</td><td>${stats.strikeouts}</td><td>${stats.hits}</td><td>${stats.walks}</td><td>${stats.hbp}</td><td>${stats.runs}</td></tr>`;
    }).join('');
    $('#stats-table-container').innerHTML = `<table class="stats-table" aria-label="${escapeHtml(team.name)}投手成績"><thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td class="stats-empty" colspan="${headers.length}">尚無投手紀錄</td></tr>`}</tbody></table>`;
  }
  function statLine() {
    return { appearances: 0, hits: 0, sacrifices: 0, rbi: 0, walks: 0, hbp: 0, strikeouts: 0, steals: 0, pickoffs: 0 };
  }
  function pitchingPlayersStat(pitcher) {
    return pitcher.stat || { outs: 0, batters: 0, strikes: 0, pitches: 0, strikeouts: 0, hits: 0, walks: 0, hbp: 0, runs: 0 };
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
  $('#record-list').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-record-index]');
    if (!button) return;
    const index = Number(button.dataset.recordIndex);
    if (!Number.isInteger(index) || index < 0 || index >= records.length) return;
    cursor = index + 1;
    state = replay(records, cursor);
    selectedInning = Number(button.dataset.recordInning);
    selectedHalf = button.dataset.recordHalf;
    saveAndRender();
    $('#record-list').querySelector(`[data-record-index="${index}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  });
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
  $('#return-latest-button').addEventListener('click', () => {
    if (cursor === records.length) return;
    returnToLatestRecord();
    showToast('已回到最新紀錄。');
  });
  $('#delete-current-button').addEventListener('click', () => {
    if (!cursor) return;
    const deletedIndex = cursor - 1;
    records.splice(deletedIndex, 1);
    cursor = Math.min(deletedIndex + 1, records.length);
    state = cursor ? replay(records, cursor) : defaultState();
    const currentEntry = currentHalfRecords().entries[cursor - 1];
    selectedInning = currentEntry?.inning ?? state.inning;
    selectedHalf = currentEntry?.half ?? state.half;
    saveAndRender();
    showToast('已刪除目前紀錄。');
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
    if (state.batterOverride || battingTeam !== activeTeamIndex(state)
      || next.orderIndexes[battingTeam] !== state.orderIndexes[battingTeam]) next.batterPitchCount = 0;
    next.batterOverride = false;
    addRecord({
      type: 'setup', code: 'set-game-state',
      balls: next.balls, strikes: next.strikes, outs: next.outs, bases: next.bases,
      inning: next.inning, half: next.half,
      teams: next.teams.map((team) => ({ innings: team.innings, hits: team.hits, errors: team.errors })),
      batterIndex: next.orderIndexes[activeTeamIndex(next)]
    });
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
    addRecord({
      type: 'setup', code: 'set-roster', gameInfo: next.gameInfo,
      teams: next.teams.map((team) => ({
        name: team.name, lineup: team.lineup, pitcher: team.pitcher
      }))
    });
    lineupDialog.close();
    showToast('已記錄比賽資訊與先發名單。');
  });

  const substitutionDialog = $('#substitution-dialog');
  function openSubstitution(mode) {
    if (mode === 'runner' && !state.bases.some(Boolean)) {
      showToast('目前壘上沒有跑者。');
      return;
    }
    substitutionMode = mode;
    const form = $('#substitution-form');
    $('#substitution-title').textContent = mode === 'defense' ? '更換守備' : mode === 'batter' ? '代打' : '代跑';
    $('#substitution-description').textContent = mode === 'defense'
      ? '換下場或交換守備位置。'
      : mode === 'batter' ? '新球員會接替目前打者的打序與守備位置。' : '選擇壘上跑者並由新球員替換。';
    $('#defense-mode-field').hidden = mode !== 'defense';
    $('#substitution-target-field').hidden = false;
    $('#substitution-target-label').textContent = '換下場球員';
    form.elements.defenseMode.value = 'replace';
    form.elements.name.value = '';
    form.elements.number.value = '';
    updateSubstitutionSlots();
    substitutionDialog.showModal();
  }
  $('#defense-change-button').addEventListener('click', () => openSubstitution('defense'));
  $('#pinch-hit-button').addEventListener('click', () => openSubstitution('batter'));
  $('#pinch-run-button').addEventListener('click', () => openSubstitution('runner'));
  $('#substitution-form').elements.defenseMode.addEventListener('change', updateSubstitutionSlots);
  function updateSubstitutionSlots() {
    const form = $('#substitution-form');
    const teamIndex = substitutionMode === 'defense' ? fieldingTeamIndex() : activeTeamIndex();
    const team = state.teams[teamIndex];
    const previousSlot = form.elements.slot.value;
    const defenseMode = form.elements.defenseMode.value;
    const currentBatterIndex = state.orderIndexes[activeTeamIndex()];
    const available = team.lineup.map((player, index) => ({ player, index }))
      .filter(({ player, index }) => substitutionMode === 'defense'
        ? player.position !== 'DH' && player.position !== 'P'
        : substitutionMode === 'batter' ? index === currentBatterIndex : false);
    const options = available.map(({ player, index }) => substitutionMode === 'defense'
      ? `<option value="${index}">${escapeHtml(player.position === 'PH' ? player.previousPosition || 'PH' : player.position)} · ${escapeHtml(player.name)} #${escapeHtml(player.number)}</option>`
      : `<option value="${index}">${index + 1} 棒 · ${escapeHtml(displayPlayerName(player))} (${escapeHtml(player.position)})</option>`).join('');
    const runnerOptions = substitutionMode === 'runner'
      ? state.bases.map((runner, index) => runner
        ? `<option value="runner:${index}">${bases[index]} · ${escapeHtml(runner)}</option>` : '').join('')
      : '';
    form.elements.slot.innerHTML = substitutionMode === 'runner'
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
      : substitutionMode === 'batter' ? '被替換打者'
        : substitutionMode === 'runner' ? '被替換跑者' : '換下場球員';
    const fixedBatterTarget = substitutionMode === 'batter';
    form.elements.slot.hidden = fixedBatterTarget;
    const targetValue = $('#substitution-target-value');
    targetValue.hidden = !fixedBatterTarget;
    if (fixedBatterTarget) {
      const player = team.lineup[currentBatterIndex];
      targetValue.textContent = `${currentBatterIndex + 1} 棒 · ${displayPlayerName(player)} (${player.position})`;
    }
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
    const teamIndex = substitutionMode === 'defense' ? fieldingTeamIndex(state) : activeTeamIndex(state);
    const team = state.teams[teamIndex];
    const selectedSlot = String(data.get('slot'));
    let runnerBaseIndex = -1;
    let slot = selectedSlot;
    if (substitutionMode === 'batter') {
      slot = String(state.orderIndexes[teamIndex]);
    } else if (substitutionMode === 'runner') {
      runnerBaseIndex = Number(selectedSlot.replace('runner:', ''));
      const runner = state.bases[runnerBaseIndex];
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
      addRecord({ type: 'substitution', code: 'swap-defense', teamIndex, slots: [index, otherIndex] });
      substitutionDialog.close();
      showToast('守備位置交換已記入。');
      return;
    }
    const outgoing = isPitcher ? team.pitcher : team.lineup[index];
    const position = isPitcher ? 'P'
      : outgoing.position === 'PH' ? outgoing.previousPosition || 'DH' : outgoing.position;
    const incoming = {
      id: `SUB-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: String(data.get('name')).trim(),
      number: String(data.get('number')).trim(),
      position: substitutionMode === 'batter' ? 'PH' : substitutionMode === 'runner' ? 'PR' : position,
      ...(substitutionMode !== 'defense' ? { previousPosition: position } : {})
    };
    addRecord({
      type: 'substitution', code: substitutionMode, teamIndex,
      slot: isPitcher ? 'pitcher' : index, player: incoming,
      ...(runnerBaseIndex >= 0 ? { base: runnerBaseIndex } : {})
    });
    substitutionDialog.close();
    showToast('球員更換已記入。');
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
      showRunnerError('出局數超過該局剩餘所需出局數。');
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
      showRunnerError('接殺出局或封殺出局時，打者必須記為出局。');
      return;
    }
    clearRunnerError();
    $('#runner-dialog').close();
    applyPlay(pendingHit, destinations);
  });

  const stealDialog = $('#steal-dialog');
  function clearStealError() {
    const error = $('#steal-error');
    error.textContent = '';
    error.hidden = true;
  }
  function openRunnerEventDialog(eventType) {
    runnerEvent = eventType;
    const runnerSelect = $('#steal-form').elements.runner;
    runnerSelect.innerHTML = state.bases.map((runner, index) => runner
      ? `<option value="${index}">${bases[index]} · ${escapeHtml(runner)}</option>` : '').join('');
    if (!state.bases.some(Boolean)) { showToast('目前壘上沒有跑者。'); return; }
    clearStealError();
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
      const error = $('#steal-error');
      error.textContent = '所選壘包上已沒有跑者，請重新選擇。';
      error.hidden = false;
      return;
    }
    const next = clone(state);
    if (runnerEvent === 'pickoff') {
      next.bases[baseIndex] = null;
      next.outs += 1;
      const result = next.outs >= 3;
      if (result) advanceHalfInning(next);
      addRecord({ type: 'runner', code: 'pickoff', base: baseIndex });
    } else {
      const destination = baseIndex + 1;
      if (destination > 2) {
        next.bases[baseIndex] = null;
        scoreRun(next, activeTeamIndex(next));
      } else if (next.bases[destination]) {
        const error = $('#steal-error');
        error.textContent = '目標壘包已有跑者，請先處理該跑者位置。';
        error.hidden = false;
        return;
      } else {
        next.bases[destination] = runner;
        next.bases[baseIndex] = null;
      }
      addRecord({ type: 'runner', code: 'steal', from: baseIndex, to: destination });
    }
    stealDialog.close();
  });
  $('#steal-form').elements.runner.addEventListener('change', clearStealError);

  document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
  $('#export-button').addEventListener('click', () => {
    const payload = JSON.stringify({ format: 'ballpark-scoreboard-v5', records, cursor });
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
      if (data.format !== 'ballpark-scoreboard-v5'
        || !Array.isArray(data.records) || !Number.isInteger(data.cursor)
        || data.cursor < 0 || data.cursor > data.records.length) throw new Error('檔案不是有效的逐球紀錄。');
      const imported = validateRecords(data.records);
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

  const statsDialog = $('#stats-dialog');
  function openStats(type) {
    statsDialogType = type;
    statsTeamIndex = type === 'batting' ? activeTeamIndex() : fieldingTeamIndex();
    renderStatsDialog();
    statsDialog.showModal();
  }
  $('#batting-stats-button').addEventListener('click', () => openStats('batting'));
  $('#pitching-stats-button').addEventListener('click', () => openStats('pitching'));
  $('#close-stats').addEventListener('click', () => statsDialog.close());
  $('#stats-team-switcher').addEventListener('click', (event) => {
    const button = event.target.closest('[data-stats-team]');
    if (!button) return;
    statsTeamIndex = Number(button.dataset.statsTeam);
    renderStatsDialog();
  });
  window.addEventListener('resize', updateGameOverHistoryHeight);
  readSavedGame();
  render();
  loadVersion();
})();
