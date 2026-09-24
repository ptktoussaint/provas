// Seleção do lote de promoção (pura, sem banco). Um usuário aparece no
// máximo uma vez, com um resultado escolhido explicitamente; as marcações
// de outras páginas são preservadas.
const MAX_SELECTIONS = 25;

function selectionFromCandidate(c, previous) {
  return {
    discordUserId: c.discordUserId,
    attemptId: c._id,
    studentName: c.studentName,
    examName: c.examId && c.examId.name ? c.examId.name : null,
    scoreAtSelection: c.effectiveScore,
    maxScore: c.maxScoreComputed,
    revisionAtSelection: c.revision || 0,
    nomeRP: previous ? previous.nomeRP : null,
    idRP: previous ? previous.idRP : null,
  };
}

// Aplica o que foi marcado na página atual, mantendo as seleções das
// outras páginas. Um usuário só pode aparecer uma vez no lote, com um
// resultado claramente escolhido. Pura.
function applySelection(currentSelections, { pageCandidates, chosenIds, max = MAX_SELECTIONS }) {
  const pageIds = new Set(pageCandidates.map((c) => String(c._id)));
  const chosen = pageCandidates.filter((c) => chosenIds.includes(String(c._id)));

  const perUser = new Map();
  for (const c of chosen) {
    if (perUser.has(c.discordUserId)) {
      return { error: `Você marcou mais de um resultado do mesmo usuário (<@${c.discordUserId}>). Escolha só UM resultado por pessoa.` };
    }
    perUser.set(c.discordUserId, c);
  }

  const removedFromPage = new Map();
  const next = [];
  for (const s of currentSelections) {
    if (pageIds.has(String(s.attemptId))) removedFromPage.set(s.discordUserId, s);
    else next.push(s);
  }

  for (const c of chosen) {
    const other = next.find((s) => s.discordUserId === c.discordUserId);
    if (other) {
      return { error: `<@${c.discordUserId}> já está no lote com outra tentativa (\`${String(other.attemptId).slice(-6)}\`). Desmarque a outra primeiro.` };
    }
    next.push(selectionFromCandidate(c, removedFromPage.get(c.discordUserId)));
  }

  if (next.length > max) return { error: `O lote pode ter no máximo ${max} pessoas.` };
  return { selections: next };
}

module.exports = { applySelection, selectionFromCandidate, MAX_SELECTIONS };
