export interface MenuCategory {
  id: string;
  name: string;
}

export interface MenuItem {
  id: string;
  categoryId: string | null;
  name: string;
  description: string | null;
  priceCents: number;
  station: 'kitchen' | 'bar';
  soldOut: boolean;
}

export interface BillLine {
  id: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  status: string;
  lineTotalCents: number;
  claimed: boolean;
  paid: boolean;
  mine: boolean;
}

export interface Bill {
  lines: BillLine[];
  totalCents: number;
  vatCents: number;
  paidCents: number;
  claimedCents: number;
  outstandingCents: number;
  unclaimedCents: number;
  itemModeOpen: boolean;
  settled: boolean;
  mySubtotalCents: number;
}

export interface TabView {
  tab: { id: string; table: string; status: 'pending' | 'open' | 'closed' };
  bill: Bill;
}

export interface PaymentSummary {
  id: string;
  mode: string;
  amountCents: number;
  tipCents: number;
  status: 'requested' | 'succeeded' | 'cancelled';
  mine: boolean;
}

export const ITEM_STATUS: Record<string, string> = {
  awaiting_confirmation: 'Waiting for your waiter',
  queued: 'Sent',
  preparing: 'Being made',
  ready: 'On its way',
  served: 'Served',
};
