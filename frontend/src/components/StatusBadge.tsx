const statusStyles: Record<string, string> = {
  healthy: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  warning: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  critical: 'text-red-400 bg-red-500/10 border-red-500/20',
  silent: 'text-gray-400 bg-gray-500/10 border-gray-500/20',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${statusStyles[status] || statusStyles.silent}`}>
      {status}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  const style = severity === 'critical' ? statusStyles.critical : statusStyles.warning;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${style}`}>
      {severity}
    </span>
  );
}
