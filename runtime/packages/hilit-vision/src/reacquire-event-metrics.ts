/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·5bf705a5 @license @preserve */
/* 재획득을 사건 단위로 세는 평가 지표. 평가 전용이다.

왜 따로 만드는가. 기존 평가기의 falseReacquire 한 칸은 두 가지를 더한 값이었다.
가림이 끝난 순간 타인을 고른 "사건" 과, 대상이 화면 밖인 동안 타인을 따라간
"프레임" 이 같은 칸에 들어갔다. 그래서 숫자가 줄어도 무엇이 좋아졌는지 알 수
없었다. 여기서는 사건과 프레임과 시간을 각각 센다.

분모가 0 이면 백분율을 만들지 않고 null 로 둔다. 아무것도 확정하지 않은
시스템의 정밀도는 100% 가 아니다.

이 모듈은 정답(truthId)을 입력으로 받는다. 평가 하네스에서만 쓰고 런타임
경로로 내보내지 않는다.
*/

export interface ReacquireFrameLog {
  tSec: number;
  /** 대상이 이 프레임에서 실제로 관측 가능했는가(가림·화면 밖이 아닌가). */
  observable: boolean;
  /** 이 프레임의 정답 대상 id. 관측 불가면 null. */
  truthId: string | null;
  /** 추적기가 현재 "대상" 으로 붙들고 있는 id. 아무것도 확정 안 했으면 null. */
  assignedId: string | null;
  /** 이 프레임에서 확정 판단을 보류했는가. */
  heldDecision: boolean;
}

export interface ReacquireEvent {
  kind: 'correct' | 'false' | 'missed';
  /** 대상이 다시 관측 가능해진 시각. */
  opportunityTSec: number;
  /** 확정된 시각. missed 면 null. */
  decidedTSec: number | null;
  /** 확정까지 걸린 시간. missed 면 null. */
  latencySec: number | null;
  decidedId: string | null;
  /** 앞선 관측 불가 구간의 길이(초). */
  gapSec: number;
}

export interface ReacquireEventMetrics {
  correctReacquireEvents: number;
  falseReacquireEvents: number;
  missedReacquireEvents: number;
  /** 대상이 다시 관측 가능했던 전체 기회 수. recall 의 분모다. */
  reacquireOpportunities: number;
  falseReacquireFrames: number;
  falseReacquireDurationSec: number;
  /** 사건별 오추적 지속시간. */
  falseReacquireSpansSec: number[];
  reacquirePrecision: number | null;
  reacquireRecall: number | null;
  /** 올바른 확정까지 걸린 시간의 중앙값. 사건이 없으면 null. */
  reacquireConfirmationLatencyMedianSec: number | null;
  reacquireConfirmationLatencySec: number[];
  postReacquireSwitchRate1s: number | null;
  postReacquireSwitchRate3s: number | null;
  postReacquireSwitchRate5s: number | null;
  noDecisionRate: number | null;
  /** MOTChallenge 식 ID switch. 대상이 보이는 프레임에서 배정이 바뀐 횟수. */
  idSwitchStandard: number;
  events: ReacquireEvent[];
  /** 분자/분모를 그대로 남긴다. 보고서에서 백분율만 쓰지 않기 위해서다. */
  fractions: Record<string, [number, number]>;
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 프레임 기록에서 사건 단위 재획득 지표를 만든다.
 *
 * 기회(opportunity)의 정의: 대상이 관측 불가였다가 다시 관측 가능해진 구간
 * 하나가 기회 하나다. 후보가 생성됐는지와 무관하다. 후보 생성 성공을 조건으로
 * 건 recall 은 여기서 내지 않는다(따로 candidateGenerationRecall 로 낸다).
 *
 * @param decisionWindowSec 기회 시작부터 이 시간 안에 확정하지 못하면 missed.
 */
export function computeReacquireEvents(
  log: readonly ReacquireFrameLog[],
  decisionWindowSec = 2,
): ReacquireEventMetrics {
  const events: ReacquireEvent[] = [];
  let falseFrames = 0;
  let falseDuration = 0;
  const falseSpans: number[] = [];
  let held = 0;
  let idSwitchStandard = 0;
  let prevAssign: string | null = null;

  /* 오추적 프레임·시간: 대상이 아닌 id 를 붙들고 있던 모든 프레임. */
  let wrongOpen: number | null = null;
  for (let i = 0; i < log.length; i += 1) {
    const f = log[i];
    const dt = i + 1 < log.length ? log[i + 1].tSec - f.tSec : (i > 0 ? f.tSec - log[i - 1].tSec : 0);
    if (f.heldDecision) held += 1;
    const wrong = f.assignedId != null && f.assignedId !== 'subject';
    if (wrong) {
      falseFrames += 1;
      falseDuration += dt;
      if (wrongOpen == null) wrongOpen = f.tSec;
    } else if (wrongOpen != null) {
      falseSpans.push(Number((f.tSec - wrongOpen).toFixed(4)));
      wrongOpen = null;
    }
    if (f.observable && f.truthId != null && f.assignedId != null) {
      if (prevAssign != null && prevAssign !== f.assignedId) idSwitchStandard += 1;
      prevAssign = f.assignedId;
    }
  }
  if (wrongOpen != null) falseSpans.push(Number((log[log.length - 1].tSec - wrongOpen).toFixed(4)));

  /* 기회 구간을 찾는다: 관측 불가 → 관측 가능 으로 바뀌는 지점. */
  for (let i = 1; i < log.length; i += 1) {
    const prev = log[i - 1];
    const cur = log[i];
    if (prev.observable || !cur.observable) continue;

    /* 앞선 공백의 길이 */
    let g = i - 1;
    while (g > 0 && !log[g - 1].observable) g -= 1;
    const gapSec = Number((cur.tSec - log[g].tSec).toFixed(4));

    let decided: ReacquireEvent | null = null;
    for (let j = i; j < log.length && log[j].tSec - cur.tSec <= decisionWindowSec; j += 1) {
      const f = log[j];
      if (!f.observable) break;
      if (f.assignedId == null) continue;
      decided = {
        kind: f.assignedId === f.truthId ? 'correct' : 'false',
        opportunityTSec: cur.tSec,
        decidedTSec: f.tSec,
        latencySec: Number((f.tSec - cur.tSec).toFixed(4)),
        decidedId: f.assignedId,
        gapSec,
      };
      break;
    }
    events.push(decided ?? {
      kind: 'missed', opportunityTSec: cur.tSec, decidedTSec: null,
      latencySec: null, decidedId: null, gapSec,
    });
  }

  const correct = events.filter((e) => e.kind === 'correct');
  const wrongEvents = events.filter((e) => e.kind === 'false');
  const missed = events.filter((e) => e.kind === 'missed');
  const decidedTotal = correct.length + wrongEvents.length;

  /* 재획득 후 재전환: 올바르게 확정한 뒤 창 안에서 배정이 바뀌었는가. */
  const switchRate = (windowSec: number): number | null => {
    if (correct.length === 0) return null;
    let switched = 0;
    for (const e of correct) {
      const t0 = e.decidedTSec as number;
      const after = log.filter((f) => f.tSec > t0 && f.tSec <= t0 + windowSec && f.observable);
      if (after.some((f) => f.assignedId != null && f.assignedId !== f.truthId)) switched += 1;
    }
    return Number((switched / correct.length).toFixed(4));
  };

  const latencies = correct.map((e) => e.latencySec as number);

  return {
    correctReacquireEvents: correct.length,
    falseReacquireEvents: wrongEvents.length,
    missedReacquireEvents: missed.length,
    reacquireOpportunities: events.length,
    falseReacquireFrames: falseFrames,
    falseReacquireDurationSec: Number(falseDuration.toFixed(4)),
    falseReacquireSpansSec: falseSpans,
    reacquirePrecision: decidedTotal ? Number((correct.length / decidedTotal).toFixed(4)) : null,
    reacquireRecall: events.length ? Number((correct.length / events.length).toFixed(4)) : null,
    reacquireConfirmationLatencyMedianSec: median(latencies),
    reacquireConfirmationLatencySec: latencies,
    postReacquireSwitchRate1s: switchRate(1),
    postReacquireSwitchRate3s: switchRate(3),
    postReacquireSwitchRate5s: switchRate(5),
    noDecisionRate: log.length ? Number((held / log.length).toFixed(4)) : null,
    idSwitchStandard,
    events,
    fractions: {
      reacquirePrecision: [correct.length, decidedTotal],
      reacquireRecall: [correct.length, events.length],
      noDecisionRate: [held, log.length],
      postReacquireSwitch1s: [
        correct.filter((e) => {
          const t0 = e.decidedTSec as number;
          return log.some((f) => f.tSec > t0 && f.tSec <= t0 + 1 && f.observable
            && f.assignedId != null && f.assignedId !== f.truthId);
        }).length,
        correct.length,
      ],
    },
  };
}

/** 여러 클립의 지표를 사건 수 기준으로 합친다. 백분율을 평균하지 않는다. */
export function mergeReacquireMetrics(
  rows: readonly ReacquireEventMetrics[],
): ReacquireEventMetrics {
  const events = rows.flatMap((r) => r.events);
  const correct = rows.reduce((a, r) => a + r.correctReacquireEvents, 0);
  const wrong = rows.reduce((a, r) => a + r.falseReacquireEvents, 0);
  const missed = rows.reduce((a, r) => a + r.missedReacquireEvents, 0);
  const opp = rows.reduce((a, r) => a + r.reacquireOpportunities, 0);
  const decided = correct + wrong;
  const latencies = rows.flatMap((r) => r.reacquireConfirmationLatencySec);
  const held = rows.reduce((a, r) => a + (r.fractions.noDecisionRate?.[0] ?? 0), 0);
  const frames = rows.reduce((a, r) => a + (r.fractions.noDecisionRate?.[1] ?? 0), 0);
  const sw1 = rows.reduce((a, r) => a + (r.fractions.postReacquireSwitch1s?.[0] ?? 0), 0);
  return {
    correctReacquireEvents: correct,
    falseReacquireEvents: wrong,
    missedReacquireEvents: missed,
    reacquireOpportunities: opp,
    falseReacquireFrames: rows.reduce((a, r) => a + r.falseReacquireFrames, 0),
    falseReacquireDurationSec: Number(rows.reduce((a, r) => a + r.falseReacquireDurationSec, 0).toFixed(4)),
    falseReacquireSpansSec: rows.flatMap((r) => r.falseReacquireSpansSec),
    reacquirePrecision: decided ? Number((correct / decided).toFixed(4)) : null,
    reacquireRecall: opp ? Number((correct / opp).toFixed(4)) : null,
    reacquireConfirmationLatencyMedianSec: median(latencies),
    reacquireConfirmationLatencySec: latencies,
    postReacquireSwitchRate1s: correct ? Number((sw1 / correct).toFixed(4)) : null,
    postReacquireSwitchRate3s: null,
    postReacquireSwitchRate5s: null,
    noDecisionRate: frames ? Number((held / frames).toFixed(4)) : null,
    idSwitchStandard: rows.reduce((a, r) => a + r.idSwitchStandard, 0),
    events,
    fractions: {
      reacquirePrecision: [correct, decided],
      reacquireRecall: [correct, opp],
      noDecisionRate: [held, frames],
      postReacquireSwitch1s: [sw1, correct],
    },
  };
}
