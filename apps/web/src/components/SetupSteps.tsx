export function SetupSteps({ current }: { current: number }) {
  return <ol aria-label="Activation progress" className="mb-7 grid grid-cols-3 gap-3 border-b border-border pb-6">
    {['Account', 'Funding', 'Activate'].map((label, index) => <li key={label} aria-current={index === current ? 'step' : undefined}
      className={`flex items-center gap-2 text-xs font-medium ${index <= current ? 'text-primary' : 'text-muted-2'}`}>
      <span aria-hidden className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border ${index < current ? 'border-primary bg-primary text-on-primary' : index === current ? 'border-primary bg-primary/10' : 'border-border-strong'}`}>{index < current ? '✓' : index + 1}</span>
      {label}
    </li>)}
  </ol>;
}
