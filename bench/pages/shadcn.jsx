// SPDX-License-Identifier: MIT
// shadcn/ui components (their source as the shadcn CLI writes it, new-york
// style: cva variants, cn = clsx + tailwind-merge, Radix primitives) on
// Tailwind v4: Card, Button, Badge, Input, Table, Tabs and Dialog (Radix:
// portal, focus trap, presence, data-state attributes).
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Slot } from '@radix-ui/react-slot';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cva } from 'class-variance-authority';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

const cn = (...a) => twMerge(clsx(a));
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  { variants: { variant: { default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90', destructive: 'bg-destructive text-white shadow-xs hover:bg-destructive/90', outline: 'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground', secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80', ghost: 'hover:bg-accent hover:text-accent-foreground' },
    size: { default: 'h-9 px-4 py-2', sm: 'h-8 rounded-md gap-1.5 px-3', lg: 'h-10 rounded-md px-6', icon: 'size-9' } }, defaultVariants: { variant: 'default', size: 'default' } });
function Button({ className, variant, size, asChild = false, ...props }) { const C = asChild ? Slot : 'button'; return <C data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />; }
const badgeVariants = cva('inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 gap-1 overflow-hidden',
  { variants: { variant: { default: 'border-transparent bg-primary text-primary-foreground', secondary: 'border-transparent bg-secondary text-secondary-foreground', destructive: 'border-transparent bg-destructive text-white', outline: 'text-foreground' } }, defaultVariants: { variant: 'default' } });
function Badge({ className, variant, ...props }) { return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />; }
function Card({ className, ...p }) { return <div data-slot="card" className={cn('bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm', className)} {...p} />; }
function CardHeader({ className, ...p }) { return <div data-slot="card-header" className={cn('grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6', className)} {...p} />; }
function CardTitle({ className, ...p }) { return <div data-slot="card-title" className={cn('leading-none font-semibold', className)} {...p} />; }
function CardDescription({ className, ...p }) { return <div data-slot="card-description" className={cn('text-muted-foreground text-sm', className)} {...p} />; }
function CardContent({ className, ...p }) { return <div data-slot="card-content" className={cn('px-6', className)} {...p} />; }
function Input({ className, type, ...p }) { return <input type={type} data-slot="input" className={cn('file:text-foreground placeholder:text-muted-foreground border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none md:text-sm focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]', className)} {...p} />; }
function Table({ className, ...p }) { return <div data-slot="table-container" className="relative w-full overflow-x-auto"><table data-slot="table" className={cn('w-full caption-bottom text-sm', className)} {...p} /></div>; }
const TableHeader = ({ className, ...p }) => <thead data-slot="table-header" className={cn('[&_tr]:border-b', className)} {...p} />;
const TableBody = ({ className, ...p }) => <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...p} />;
const TableRow = ({ className, ...p }) => <tr data-slot="table-row" className={cn('hover:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors', className)} {...p} />;
const TableHead = ({ className, ...p }) => <th data-slot="table-head" className={cn('text-foreground h-10 px-2 text-left align-middle font-medium whitespace-nowrap', className)} {...p} />;
const TableCell = ({ className, ...p }) => <td data-slot="table-cell" className={cn('p-2 align-middle whitespace-nowrap', className)} {...p} />;
const Tabs = ({ className, ...p }) => <TabsPrimitive.Root data-slot="tabs" className={cn('flex flex-col gap-2', className)} {...p} />;
const TabsList = ({ className, ...p }) => <TabsPrimitive.List data-slot="tabs-list" className={cn('bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-lg p-[3px]', className)} {...p} />;
const TabsTrigger = ({ className, ...p }) => <TabsPrimitive.Trigger data-slot="tabs-trigger" className={cn("data-[state=active]:bg-background text-foreground inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] data-[state=active]:shadow-sm", className)} {...p} />;
const TabsContent = ({ className, ...p }) => <TabsPrimitive.Content data-slot="tabs-content" className={cn('flex-1 outline-none', className)} {...p} />;
function DialogContent({ className, children, ...p }) {
  return <DialogPrimitive.Portal><DialogPrimitive.Overlay data-slot="dialog-overlay" className="data-[state=open]:animate-in data-[state=closed]:animate-out fixed inset-0 z-50 bg-black/50" />
    <DialogPrimitive.Content data-slot="dialog-content" className={cn('bg-background fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 sm:max-w-lg', className)} {...p}>
      {children}<DialogPrimitive.Close className="absolute top-4 right-4 rounded-xs opacity-70" id="dclose">x</DialogPrimitive.Close></DialogPrimitive.Content></DialogPrimitive.Portal>;
}
const invoices = Array.from({ length: 30 }, (_, i) => ({ id: 'INV' + String(i + 1).padStart(3, '0'), status: ['Paid', 'Pending', 'Unpaid'][i % 3], method: ['Credit Card', 'PayPal', 'Bank Transfer'][i % 3], amount: (250 + i * 37.5).toFixed(2) }));
let api = {};
function App() {
  const [open, setOpen] = React.useState(false);
  const [tab, setTab] = React.useState('invoices');
  const [q, setQ] = React.useState('');
  const [sel, setSel] = React.useState(null);
  api = { setOpen, setTab, setQ, setSel };
  const rows = invoices.filter((r) => !q || r.status.toLowerCase().includes(q.toLowerCase()));
  return <div className="p-6 flex flex-col gap-6">
    <div className="grid grid-cols-3 gap-4">
      {['Revenue', 'Subscriptions', 'Active now'].map((t, i) => <Card key={t}><CardHeader><CardDescription>{t}</CardDescription><CardTitle className="text-2xl tabular-nums">{['$45,231.89', '+2350', '+573'][i]}</CardTitle></CardHeader><CardContent><Badge variant={i === 2 ? 'secondary' : 'outline'}>+{(i + 1) * 12.5}%</Badge></CardContent></Card>)}
    </div>
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList><TabsTrigger value="invoices" id="t-inv">Invoices</TabsTrigger><TabsTrigger value="settings" id="t-set">Settings</TabsTrigger></TabsList>
      <TabsContent value="invoices">
        <div className="flex items-center gap-2 mb-2"><Input id="q" placeholder="Filter status..." value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
          <DialogPrimitive.Root open={open} onOpenChange={setOpen}><DialogPrimitive.Trigger asChild><Button variant="outline" id="dopen">Edit profile</Button></DialogPrimitive.Trigger>
            <DialogContent><DialogPrimitive.Title className="text-lg leading-none font-semibold">Edit profile</DialogPrimitive.Title><DialogPrimitive.Description className="text-muted-foreground text-sm">Make changes to your profile here.</DialogPrimitive.Description>
              <div className="grid gap-3"><label className="text-sm font-medium" htmlFor="nm">Name</label><Input id="nm" defaultValue="Pedro Duarte" /></div>
              <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => setOpen(false)}>Save changes</Button></div></DialogContent></DialogPrimitive.Root>
          <Button variant="destructive" size="sm">Delete</Button></div>
        <Table><TableHeader><TableRow><TableHead className="w-[100px]">Invoice</TableHead><TableHead>Status</TableHead><TableHead>Method</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader>
          <TableBody>{rows.map((r) => <TableRow key={r.id} data-state={sel === r.id ? 'selected' : undefined}><TableCell className="font-medium">{r.id}</TableCell><TableCell><Badge variant={r.status === 'Paid' ? 'default' : r.status === 'Pending' ? 'secondary' : 'destructive'}>{r.status}</Badge></TableCell><TableCell>{r.method}</TableCell><TableCell className="text-right">${r.amount}</TableCell></TableRow>)}</TableBody></Table>
      </TabsContent>
      <TabsContent value="settings"><Card><CardHeader><CardTitle>Settings</CardTitle><CardDescription>Manage your account.</CardDescription></CardHeader><CardContent className="grid gap-2"><Input placeholder="Email" /><Button className="w-fit">Save</Button></CardContent></Card></TabsContent>
    </Tabs>
  </div>;
}
const root = createRoot(document.getElementById('app'));
flushSync(() => root.render(<App />));
const $ = (s) => document.querySelector(s);
function wait(pred, ms) { const end = Date.now() + (ms || 3000); return new Promise((ok) => { (function f() { if (pred() || Date.now() > end) ok(); else setTimeout(f, 20); })(); }); }
window.__benchCase = {
  steps: [
    { name: 'filter rows "paid"', run: () => flushSync(() => api.setQ('paid')) },
    { name: 'select a row', run: () => flushSync(() => api.setSel('INV004')) },
    { name: 'open dialog (Radix)', run: () => { $('#dopen').click(); return wait(() => !!$('[data-slot=dialog-content]')); } },
    { name: 'close dialog', run: () => { $('#dclose').click(); return wait(() => !$('[data-slot=dialog-content]')); } },
    { name: 'switch tab (Radix)', run: () => { flushSync(() => api.setTab('settings')); } },
    { name: 'back to invoices, clear filter', run: () => flushSync(() => { api.setTab('invoices'); api.setQ(''); }) }
  ],
  probe: () => {
    const tr = document.querySelectorAll('[data-slot=table-body] tr'), d = $('[data-slot=dialog-content]');
    return { rows: tr.length, dialog: !!d, focusInDialog: !!d && d.contains(document.activeElement), tab: ($('[data-slot=tabs-trigger][data-state=active]') || {}).textContent || null,
      selBg: tr[1] ? getComputedStyle(tr[1]).backgroundColor : null };
  },
};
