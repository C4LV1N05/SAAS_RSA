import { rand } from '../lib/money';
import { ITEM_STATUS, type PaymentSummary, type TabView } from './types';

interface Props {
  view: TabView;
  waitingPayment: PaymentSummary | undefined;
  onPay: () => void;
  onOrderMore: () => void;
}

export function BillView({ view, waitingPayment, onPay, onOrderMore }: Props) {
  const { bill } = view;
  const lines = bill.lines.filter((l) => l.status !== 'void');

  if (lines.length === 0) {
    return (
      <section>
        <p>Nothing ordered yet.</p>
        <button className="btn btn-go" onClick={onOrderMore}>See the menu</button>
      </section>
    );
  }

  return (
    <section aria-label="Your bill">
      {lines.map((l) => (
        <div key={l.id} className={`bill-line${l.mine ? ' mine' : ''}${l.paid ? ' paid' : ''}`}>
          <span className="qty num">{l.quantity}×</span>
          <span>
            <span className="what">{l.name}</span>
            {!l.paid && <span className="state">{ITEM_STATUS[l.status] ?? l.status}</span>}
          </span>
          <span className="amount num">{rand(l.lineTotalCents)}</span>
        </div>
      ))}

      <div className="bill-totals">
        <div>
          <span>Total</span>
          <span className="num">{rand(bill.totalCents)}</span>
        </div>
        <div className="quiet">
          <span>Includes VAT (15%)</span>
          <span className="num">{rand(bill.vatCents)}</span>
        </div>
        {bill.paidCents > 0 && (
          <div className="quiet">
            <span>Paid</span>
            <span className="num">−{rand(bill.paidCents)}</span>
          </div>
        )}
        <div className="grand">
          <span>To pay</span>
          <span className="num">{rand(bill.outstandingCents)}</span>
        </div>
      </div>

      {waitingPayment ? (
        <div className="waiting" role="status">
          <p className="quiet">Your waiter is bringing the card machine for</p>
          <p className="big num">{rand(waitingPayment.amountCents + waitingPayment.tipCents)}</p>
          {waitingPayment.tipCents > 0 && <p className="quiet">including a {rand(waitingPayment.tipCents)} tip</p>}
        </div>
      ) : (
        bill.unclaimedCents > 0 && (
          <button className="btn btn-go btn-block" onClick={onPay}>Pay</button>
        )
      )}
      <p style={{ textAlign: 'center', marginTop: '1.25rem' }}>
        <button className="link" onClick={onOrderMore}>Order something else</button>
      </p>
    </section>
  );
}
