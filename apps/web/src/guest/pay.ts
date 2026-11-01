/** What each payment choice would cost right now (mirrors the API's rules). */
import type { Bill } from './types';

export type PayMode = 'items' | 'remaining' | 'share';

export interface PayChoice {
  mode: PayMode;
  amountCents: number;
  available: boolean;
  reason?: string;
  itemIds?: string[];
}

export function payChoices(bill: Bill, parts: number): Record<PayMode, PayChoice> {
  const myOpen = bill.lines.filter((l) => l.mine && !l.claimed && l.status !== 'void' && l.lineTotalCents > 0);
  const myCents = myOpen.reduce((s, l) => s + l.lineTotalCents, 0);
  const share = Math.min(Math.ceil(bill.totalCents / Math.max(2, parts)), bill.unclaimedCents);
  const shareBlocked = bill.itemModeOpen && bill.claimedCents > 0;

  return {
    items: {
      mode: 'items',
      amountCents: myCents,
      itemIds: myOpen.map((l) => l.id),
      available: bill.itemModeOpen && myCents > 0,
      ...(!bill.itemModeOpen
        ? { reason: 'Someone split the bill equally, so pay a share or the rest' }
        : myCents === 0
          ? { reason: 'Nothing of yours is left to pay' }
          : {}),
    },
    remaining: {
      mode: 'remaining',
      amountCents: bill.unclaimedCents,
      available: bill.unclaimedCents > 0,
      ...(bill.unclaimedCents === 0 ? { reason: 'Everything is paid or being paid' } : {}),
    },
    share: {
      mode: 'share',
      amountCents: share,
      available: !shareBlocked && share > 0,
      ...(shareBlocked ? { reason: 'Someone already paid for their own items' } : {}),
    },
  };
}
