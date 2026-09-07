import { tokenLogoAsset } from '@/lib/token-logo-assets';
import { TokenLogo } from './icons';

/** Replace known ticker words only; unknown assets and surrounding prose stay intact. */
export function ProofSummary({ text }: { text: string }) {
  return <>{text.split(/\b(USDT|USDC|WBNB|TBNB|BNB|BTCB)\b/g).map((part, index) =>
    tokenLogoAsset(part)
      ? <span key={index} className="mx-1 inline-flex align-middle" role="img" aria-label={part} title={part}>
          <TokenLogo symbol={part} className="h-[38px] w-[38px]" />
        </span>
      : part,
  )}</>;
}
