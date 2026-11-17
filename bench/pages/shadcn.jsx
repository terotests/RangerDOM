// SPDX-License-Identifier: MIT
// shadcn/ui components as the shadcn CLI writes them (new-york v4: cva
// variants, cn = clsx + tailwind-merge, Radix primitives from "radix-ui",
// lucide icons, tw-animate-css enter/exit animations) on Tailwind v4, one
// card per component. Steps drive them as a person would: pointer presses,
// hovers, keys and typing dispatched to the elements (not React state), so
// Radix's own handlers (pointerdown triggers, dismissable layers, focus
// scopes, roving focus, presence on animationend) run in both engines.
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Accordion as AccordionP, AlertDialog as AlertDialogP, Avatar as AvatarP, Checkbox as CheckboxP, Collapsible as CollapsibleP, ContextMenu as ContextMenuP, Dialog as DialogP, DropdownMenu as DropdownMenuP, HoverCard as HoverCardP, Label as LabelP, Menubar as MenubarP, NavigationMenu as NavP, Popover as PopoverP, Progress as ProgressP, RadioGroup as RadioGroupP, ScrollArea as ScrollAreaP, Select as SelectP, Separator as SeparatorP, Slider as SliderP, Slot, Switch as SwitchP, Tabs as TabsP, Toggle as ToggleP, ToggleGroup as ToggleGroupP, Tooltip as TooltipP } from 'radix-ui';
import { Command as CommandP } from 'cmdk';
import { DayPicker } from 'react-day-picker';
import { Toaster, toast } from 'sonner';
import { Drawer as DrawerP } from 'vaul';
import { OTPInput, OTPInputContext } from 'input-otp';
import { cva } from 'class-variance-authority';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { AlertCircle, Bold, Calendar as CalendarIcon, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, Circle, Italic, Minus, MoreHorizontal, Search, Terminal, Underline, X } from 'lucide-react';

const cn = (...a) => twMerge(clsx(a));

// ---- shadcn/ui components (ui.shadcn.com, MIT) ----
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  { variants: { variant: { default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90', destructive: 'bg-destructive text-white shadow-xs hover:bg-destructive/90', outline: 'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground', secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80', ghost: 'hover:bg-accent hover:text-accent-foreground', link: 'text-primary underline-offset-4 hover:underline' },
    size: { default: 'h-9 px-4 py-2 has-[>svg]:px-3', sm: 'h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5', lg: 'h-10 rounded-md px-6 has-[>svg]:px-4', icon: 'size-9' } }, defaultVariants: { variant: 'default', size: 'default' } });
function Button({ className, variant, size, asChild = false, ...props }) { const C = asChild ? Slot.Root : 'button'; return <C data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />; }
const badgeVariants = cva('inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none overflow-hidden',
  { variants: { variant: { default: 'border-transparent bg-primary text-primary-foreground', secondary: 'border-transparent bg-secondary text-secondary-foreground', destructive: 'border-transparent bg-destructive text-white', outline: 'text-foreground' } }, defaultVariants: { variant: 'default' } });
function Badge({ className, variant, ...props }) { return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />; }
function Card({ className, ...p }) { return <div data-slot="card" className={cn('bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm', className)} {...p} />; }
function CardHeader({ className, ...p }) { return <div data-slot="card-header" className={cn('grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6', className)} {...p} />; }
function CardTitle({ className, ...p }) { return <div data-slot="card-title" className={cn('leading-none font-semibold', className)} {...p} />; }
function CardDescription({ className, ...p }) { return <div data-slot="card-description" className={cn('text-muted-foreground text-sm', className)} {...p} />; }
function CardContent({ className, ...p }) { return <div data-slot="card-content" className={cn('px-6', className)} {...p} />; }
function CardFooter({ className, ...p }) { return <div data-slot="card-footer" className={cn('flex items-center px-6', className)} {...p} />; }
function Input({ className, type, ...p }) { return <input type={type} data-slot="input" className={cn('file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:border-destructive', className)} {...p} />; }
function Textarea({ className, ...p }) { return <textarea data-slot="textarea" className={cn('border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] md:text-sm', className)} {...p} />; }
function Label({ className, ...p }) { return <LabelP.Root data-slot="label" className={cn('flex items-center gap-2 text-sm leading-none font-medium select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50', className)} {...p} />; }
function Separator({ className, orientation = 'horizontal', decorative = true, ...p }) { return <SeparatorP.Root data-slot="separator" decorative={decorative} orientation={orientation} className={cn('bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px', className)} {...p} />; }
function Skeleton({ className, ...p }) { return <div data-slot="skeleton" className={cn('bg-accent animate-pulse rounded-md', className)} {...p} />; }
function Kbd({ className, ...p }) { return <kbd data-slot="kbd" className={cn('bg-muted text-muted-foreground pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-sm px-1 font-sans text-xs font-medium select-none', className)} {...p} />; }

const alertVariants = cva('relative w-full rounded-lg border px-4 py-3 text-sm grid has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-0.5 items-start [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current',
  { variants: { variant: { default: 'bg-card text-card-foreground', destructive: 'text-destructive bg-card [&>svg]:text-current *:data-[slot=alert-description]:text-destructive/90' } }, defaultVariants: { variant: 'default' } });
function Alert({ className, variant, ...p }) { return <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...p} />; }
function AlertTitle({ className, ...p }) { return <div data-slot="alert-title" className={cn('col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight', className)} {...p} />; }
function AlertDescription({ className, ...p }) { return <div data-slot="alert-description" className={cn('text-muted-foreground col-start-2 grid justify-items-start gap-1 text-sm [&_p]:leading-relaxed', className)} {...p} />; }

function Accordion(p) { return <AccordionP.Root data-slot="accordion" {...p} />; }
function AccordionItem({ className, ...p }) { return <AccordionP.Item data-slot="accordion-item" className={cn('border-b last:border-b-0', className)} {...p} />; }
function AccordionTrigger({ className, children, ...p }) {
  return <AccordionP.Header className="flex"><AccordionP.Trigger data-slot="accordion-trigger" className={cn('focus-visible:border-ring focus-visible:ring-ring/50 flex flex-1 items-start justify-between gap-4 rounded-md py-4 text-left text-sm font-medium transition-all outline-none hover:underline focus-visible:ring-[3px] [&[data-state=open]>svg]:rotate-180', className)} {...p}>{children}<ChevronDown className="text-muted-foreground pointer-events-none size-4 shrink-0 translate-y-0.5 transition-transform duration-200" /></AccordionP.Trigger></AccordionP.Header>;
}
function AccordionContent({ className, children, ...p }) { return <AccordionP.Content data-slot="accordion-content" className="data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down overflow-hidden text-sm" {...p}><div className={cn('pt-0 pb-4', className)}>{children}</div></AccordionP.Content>; }

const overlayCls = 'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50';
const modalCls = 'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 sm:max-w-lg';
function DialogContent({ className, children, ...p }) {
  return <DialogP.Portal><DialogP.Overlay data-slot="dialog-overlay" className={overlayCls} />
    <DialogP.Content data-slot="dialog-content" className={cn(modalCls, className)} {...p}>
      {children}<DialogP.Close id="dclose" className="ring-offset-background focus:ring-ring absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"><X /><span className="sr-only">Close</span></DialogP.Close></DialogP.Content></DialogP.Portal>;
}
const DialogHeader = ({ className, ...p }) => <div data-slot="dialog-header" className={cn('flex flex-col gap-2 text-center sm:text-left', className)} {...p} />;
const DialogFooter = ({ className, ...p }) => <div data-slot="dialog-footer" className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...p} />;
const DialogTitle = ({ className, ...p }) => <DialogP.Title data-slot="dialog-title" className={cn('text-lg leading-none font-semibold', className)} {...p} />;
const DialogDescription = ({ className, ...p }) => <DialogP.Description data-slot="dialog-description" className={cn('text-muted-foreground text-sm', className)} {...p} />;

function AlertDialogContent({ className, ...p }) { return <AlertDialogP.Portal><AlertDialogP.Overlay data-slot="alert-dialog-overlay" className={overlayCls} /><AlertDialogP.Content data-slot="alert-dialog-content" className={cn(modalCls, className)} {...p} /></AlertDialogP.Portal>; }

const sheetSide = { right: 'data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm', left: 'data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm' };
function SheetContent({ className, children, side = 'right', ...p }) {
  return <DialogP.Portal><DialogP.Overlay data-slot="sheet-overlay" className={overlayCls} /><DialogP.Content data-slot="sheet-content" className={cn('bg-background data-[state=open]:animate-in data-[state=closed]:animate-out fixed z-50 flex flex-col gap-4 shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500', sheetSide[side], className)} {...p}>{children}
    <DialogP.Close id="sheet-close" className="ring-offset-background focus:ring-ring absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden"><X className="size-4" /><span className="sr-only">Close</span></DialogP.Close></DialogP.Content></DialogP.Portal>;
}

const popCls = 'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50';
function PopoverContent({ className, align = 'center', sideOffset = 4, ...p }) { return <PopoverP.Portal><PopoverP.Content data-slot="popover-content" align={align} sideOffset={sideOffset} className={cn(popCls, 'w-72 origin-(--radix-popover-content-transform-origin) rounded-md border p-4 shadow-md outline-hidden', className)} {...p} /></PopoverP.Portal>; }
function HoverCardContent({ className, align = 'center', sideOffset = 4, ...p }) { return <HoverCardP.Portal><HoverCardP.Content data-slot="hover-card-content" align={align} sideOffset={sideOffset} className={cn(popCls, 'w-64 origin-(--radix-hover-card-content-transform-origin) rounded-md border p-4 shadow-md outline-hidden', className)} {...p} /></HoverCardP.Portal>; }
function TooltipContent({ className, sideOffset = 0, children, ...p }) {
  return <TooltipP.Portal><TooltipP.Content data-slot="tooltip-content" sideOffset={sideOffset} className={cn('bg-primary text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-1.5 text-xs text-balance', className)} {...p}>{children}<TooltipP.Arrow className="bg-primary fill-primary z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]" /></TooltipP.Content></TooltipP.Portal>;
}

const menuCls = 'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 z-50 min-w-[8rem] overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md';
const itemCls = "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";
const checkItemCls = "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50";
const labelCls = 'px-2 py-1.5 text-sm font-medium data-[inset]:pl-8';
const sepCls = 'bg-border -mx-1 my-1 h-px';
const shortcutCls = 'text-muted-foreground ml-auto text-xs tracking-widest';
const subTriggerCls = 'focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[inset]:pl-8';
function menuKit(P, slot) {
  return {
    Content: ({ className, sideOffset = 4, ...p }) => <P.Portal><P.Content data-slot={slot + '-content'} sideOffset={sideOffset} className={cn(menuCls, className)} {...p} /></P.Portal>,
    Item: ({ className, inset, variant = 'default', ...p }) => <P.Item data-slot={slot + '-item'} data-inset={inset} data-variant={variant} className={cn(itemCls, className)} {...p} />,
    CheckboxItem: ({ className, children, ...p }) => <P.CheckboxItem data-slot={slot + '-checkbox-item'} className={cn(checkItemCls, className)} {...p}><span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center"><P.ItemIndicator><Check className="size-4" /></P.ItemIndicator></span>{children}</P.CheckboxItem>,
    RadioItem: ({ className, children, ...p }) => <P.RadioItem data-slot={slot + '-radio-item'} className={cn(checkItemCls, className)} {...p}><span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center"><P.ItemIndicator><Circle className="size-2 fill-current" /></P.ItemIndicator></span>{children}</P.RadioItem>,
    Label: ({ className, inset, ...p }) => <P.Label data-slot={slot + '-label'} data-inset={inset} className={cn(labelCls, className)} {...p} />,
    Separator: ({ className, ...p }) => <P.Separator data-slot={slot + '-separator'} className={cn(sepCls, className)} {...p} />,
    Shortcut: ({ className, ...p }) => <span data-slot={slot + '-shortcut'} className={cn(shortcutCls, className)} {...p} />,
    SubTrigger: ({ className, inset, children, ...p }) => <P.SubTrigger data-slot={slot + '-sub-trigger'} data-inset={inset} className={cn(subTriggerCls, className)} {...p}>{children}<ChevronRight className="ml-auto size-4" /></P.SubTrigger>,
    SubContent: ({ className, ...p }) => <P.Portal><P.SubContent data-slot={slot + '-sub-content'} className={cn(menuCls, 'shadow-lg', className)} {...p} /></P.Portal>,
  };
}
const DM = menuKit(DropdownMenuP, 'dropdown-menu');
const CM = menuKit(ContextMenuP, 'context-menu');
const MB = menuKit(MenubarP, 'menubar');

function SelectTrigger({ className, children, ...p }) { return <SelectP.Trigger data-slot="select-trigger" className={cn("border-input data-[placeholder]:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 flex w-fit items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] h-9 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4", className)} {...p}>{children}<SelectP.Icon asChild><ChevronDown className="size-4 opacity-50" /></SelectP.Icon></SelectP.Trigger>; }
function SelectContent({ className, children, position = 'popper', ...p }) {
  return <SelectP.Portal><SelectP.Content data-slot="select-content" position={position} className={cn('bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 relative z-50 max-h-(--radix-select-content-available-height) min-w-[8rem] origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border shadow-md', position === 'popper' && 'data-[side=bottom]:translate-y-1', className)} {...p}>
    <SelectP.Viewport className={cn('p-1', position === 'popper' && 'h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1')}>{children}</SelectP.Viewport></SelectP.Content></SelectP.Portal>;
}
function SelectItem({ className, children, ...p }) { return <SelectP.Item data-slot="select-item" className={cn("focus:bg-accent focus:text-accent-foreground relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50", className)} {...p}><span className="absolute right-2 flex size-3.5 items-center justify-center"><SelectP.ItemIndicator><Check className="size-4" /></SelectP.ItemIndicator></span><SelectP.ItemText>{children}</SelectP.ItemText></SelectP.Item>; }

function Checkbox({ className, ...p }) { return <CheckboxP.Root data-slot="checkbox" className={cn('peer border-input data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:border-primary focus-visible:border-ring focus-visible:ring-ring/50 size-4 shrink-0 rounded-[4px] border shadow-xs transition-shadow outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50', className)} {...p}><CheckboxP.Indicator data-slot="checkbox-indicator" className="flex items-center justify-center text-current transition-none"><Check className="size-3.5" /></CheckboxP.Indicator></CheckboxP.Root>; }
function Switch({ className, ...p }) { return <SwitchP.Root data-slot="switch" className={cn('peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-input focus-visible:border-ring focus-visible:ring-ring/50 inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50', className)} {...p}><SwitchP.Thumb data-slot="switch-thumb" className="bg-background pointer-events-none block size-4 rounded-full ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0" /></SwitchP.Root>; }
function RadioGroup({ className, ...p }) { return <RadioGroupP.Root data-slot="radio-group" className={cn('grid gap-3', className)} {...p} />; }
function RadioGroupItem({ className, ...p }) { return <RadioGroupP.Item data-slot="radio-group-item" className={cn('border-input text-primary focus-visible:border-ring focus-visible:ring-ring/50 aspect-square size-4 shrink-0 rounded-full border shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50', className)} {...p}><RadioGroupP.Indicator data-slot="radio-group-indicator" className="relative flex items-center justify-center"><Circle className="fill-primary absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2" /></RadioGroupP.Indicator></RadioGroupP.Item>; }
function Progress({ className, value, ...p }) { return <ProgressP.Root data-slot="progress" className={cn('bg-primary/20 relative h-2 w-full overflow-hidden rounded-full', className)} {...p}><ProgressP.Indicator data-slot="progress-indicator" className="bg-primary h-full w-full flex-1 transition-all" style={{ transform: `translateX(-${100 - (value || 0)}%)` }} /></ProgressP.Root>; }
function Slider({ className, defaultValue, value, min = 0, max = 100, ...p }) {
  const vals = React.useMemo(() => Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min, max], [value, defaultValue, min, max]);
  return <SliderP.Root data-slot="slider" defaultValue={defaultValue} value={value} min={min} max={max} className={cn('relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50', className)} {...p}>
    <SliderP.Track data-slot="slider-track" className="bg-muted relative grow overflow-hidden rounded-full h-1.5 w-full"><SliderP.Range data-slot="slider-range" className="bg-primary absolute h-full" /></SliderP.Track>
    {Array.from({ length: vals.length }, (_, i) => <SliderP.Thumb data-slot="slider-thumb" key={i} className="border-primary ring-ring/50 block size-4 shrink-0 rounded-full border bg-white shadow-sm transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden" />)}</SliderP.Root>;
}
const toggleVariants = cva("inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium hover:bg-muted hover:text-muted-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 outline-none transition-[color,box-shadow] whitespace-nowrap",
  { variants: { variant: { default: 'bg-transparent', outline: 'border border-input bg-transparent shadow-xs hover:bg-accent hover:text-accent-foreground' }, size: { default: 'h-9 px-2 min-w-9', sm: 'h-8 px-1.5 min-w-8', lg: 'h-10 px-2.5 min-w-10' } }, defaultVariants: { variant: 'default', size: 'default' } });
function Toggle({ className, variant, size, ...p }) { return <ToggleP.Root data-slot="toggle" className={cn(toggleVariants({ variant, size, className }))} {...p} />; }
function ToggleGroup({ className, variant, size, children, ...p }) { return <ToggleGroupP.Root data-slot="toggle-group" data-variant={variant} className={cn('group/toggle-group flex w-fit items-center rounded-md data-[variant=outline]:shadow-xs', className)} {...p}>{React.Children.map(children, (c) => React.cloneElement(c, { variant, size }))}</ToggleGroupP.Root>; }
function ToggleGroupItem({ className, variant, size, ...p }) { return <ToggleGroupP.Item data-slot="toggle-group-item" className={cn(toggleVariants({ variant, size }), 'min-w-0 flex-1 shrink-0 rounded-none shadow-none first:rounded-l-md last:rounded-r-md focus:z-10 focus-visible:z-10 data-[variant=outline]:border-l-0 data-[variant=outline]:first:border-l', className)} {...p} />; }
function Avatar({ className, ...p }) { return <AvatarP.Root data-slot="avatar" className={cn('relative flex size-8 shrink-0 overflow-hidden rounded-full', className)} {...p} />; }
function AvatarImage({ className, ...p }) { return <AvatarP.Image data-slot="avatar-image" className={cn('aspect-square size-full', className)} {...p} />; }
function AvatarFallback({ className, ...p }) { return <AvatarP.Fallback data-slot="avatar-fallback" className={cn('bg-muted flex size-full items-center justify-center rounded-full', className)} {...p} />; }
function ScrollArea({ className, children, ...p }) {
  return <ScrollAreaP.Root data-slot="scroll-area" className={cn('relative', className)} {...p}><ScrollAreaP.Viewport data-slot="scroll-area-viewport" className="size-full rounded-[inherit] outline-none">{children}</ScrollAreaP.Viewport>
    <ScrollAreaP.ScrollAreaScrollbar data-slot="scroll-area-scrollbar" orientation="vertical" className="flex touch-none p-px transition-colors select-none h-full w-2.5 border-l border-l-transparent"><ScrollAreaP.ScrollAreaThumb data-slot="scroll-area-thumb" className="bg-border relative flex-1 rounded-full" /></ScrollAreaP.ScrollAreaScrollbar><ScrollAreaP.Corner /></ScrollAreaP.Root>;
}
function Collapsible(p) { return <CollapsibleP.Root data-slot="collapsible" {...p} />; }

function Command({ className, ...p }) { return <CommandP data-slot="command" className={cn('bg-popover text-popover-foreground flex h-full w-full flex-col overflow-hidden rounded-md', className)} {...p} />; }
function CommandInput({ className, ...p }) { return <div data-slot="command-input-wrapper" className="flex h-9 items-center gap-2 border-b px-3"><Search className="size-4 shrink-0 opacity-50" /><CommandP.Input data-slot="command-input" className={cn('placeholder:text-muted-foreground flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50', className)} {...p} /></div>; }
const CommandList = ({ className, ...p }) => <CommandP.List data-slot="command-list" className={cn('max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto', className)} {...p} />;
const CommandEmpty = (p) => <CommandP.Empty data-slot="command-empty" className="py-6 text-center text-sm" {...p} />;
const CommandGroup = ({ className, ...p }) => <CommandP.Group data-slot="command-group" className={cn('text-foreground [&_[cmdk-group-heading]]:text-muted-foreground overflow-hidden p-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium', className)} {...p} />;
const CommandSeparator = ({ className, ...p }) => <CommandP.Separator data-slot="command-separator" className={cn('bg-border -mx-1 h-px', className)} {...p} />;
const CommandItem = ({ className, ...p }) => <CommandP.Item data-slot="command-item" className={cn("data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4", className)} {...p} />;

function Calendar({ className, classNames, showOutsideDays = true, ...p }) {
  return <DayPicker showOutsideDays={showOutsideDays} className={cn('bg-background group/calendar p-3 [--cell-size:--spacing(8)]', className)}
    classNames={{ root: 'w-fit', months: 'flex gap-4 flex-col md:flex-row relative', month: 'flex flex-col w-full gap-4', nav: 'flex items-center gap-1 w-full absolute top-0 inset-x-0 justify-between',
      button_previous: cn(buttonVariants({ variant: 'ghost' }), 'size-(--cell-size) aria-disabled:opacity-50 p-0 select-none'), button_next: cn(buttonVariants({ variant: 'ghost' }), 'size-(--cell-size) aria-disabled:opacity-50 p-0 select-none'),
      month_caption: 'flex items-center justify-center h-(--cell-size) w-full px-(--cell-size)', caption_label: 'select-none font-medium text-sm', table: 'w-full border-collapse', weekdays: 'flex', weekday: 'text-muted-foreground rounded-md flex-1 font-normal text-[0.8rem] select-none',
      week: 'flex w-full mt-2', day: 'relative w-full h-full p-0 text-center group/day aspect-square select-none', today: 'bg-accent text-accent-foreground rounded-md data-[selected=true]:rounded-none', outside: 'text-muted-foreground aria-selected:text-muted-foreground', disabled: 'text-muted-foreground opacity-50', hidden: 'invisible', ...classNames }}
    components={{ Chevron: ({ orientation, className: c, ...q }) => orientation === 'left' ? <ChevronLeft className={cn('size-4', c)} {...q} /> : <ChevronRight className={cn('size-4', c)} {...q} />,
      DayButton: ({ day, modifiers, className: c, ...q }) => <Button variant="ghost" size="icon" data-day={day.date.toLocaleDateString('en-US')} data-selected-single={modifiers.selected || undefined}
        className={cn('data-[selected-single=true]:bg-primary data-[selected-single=true]:text-primary-foreground flex aspect-square size-auto w-full min-w-(--cell-size) flex-col gap-1 leading-none font-normal', c)} {...q} /> }} {...p} />;
}

function InputOTPSlot({ index, className }) {
  const ctx = React.useContext(OTPInputContext);
  const { char, hasFakeCaret, isActive } = ctx?.slots[index] ?? {};
  return <div data-slot="input-otp-slot" data-active={isActive} className={cn('data-[active=true]:border-ring data-[active=true]:ring-ring/50 border-input relative flex h-9 w-9 items-center justify-center border-y border-r text-sm shadow-xs transition-all outline-none first:rounded-l-md first:border-l last:rounded-r-md data-[active=true]:z-10 data-[active=true]:ring-[3px]', className)}>
    {char}{hasFakeCaret && <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><div className="animate-caret-blink bg-foreground h-4 w-px duration-1000" /></div>}</div>;
}

function DrawerContent({ className, children, ...p }) {
  return <DrawerP.Portal><DrawerP.Overlay data-slot="drawer-overlay" className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50" />
    <DrawerP.Content data-slot="drawer-content" className={cn('group/drawer-content bg-background fixed z-50 flex h-auto flex-col data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:mt-24 data-[vaul-drawer-direction=bottom]:max-h-[80vh] data-[vaul-drawer-direction=bottom]:rounded-t-lg data-[vaul-drawer-direction=bottom]:border-t', className)} {...p}>
      <div className="bg-muted mx-auto mt-4 hidden h-2 w-[100px] shrink-0 rounded-full group-data-[vaul-drawer-direction=bottom]/drawer-content:block" />{children}</DrawerP.Content></DrawerP.Portal>;
}

const navTriggerStyle = cva('group inline-flex h-9 w-max items-center justify-center rounded-md bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=open]:hover:bg-accent data-[state=open]:text-accent-foreground data-[state=open]:focus:bg-accent data-[state=open]:bg-accent/50 focus-visible:ring-ring/50 outline-none transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:outline-1');
function NavigationMenu({ className, children, ...p }) {
  return <NavP.Root data-slot="navigation-menu" className={cn('group/navigation-menu relative flex max-w-max flex-1 items-center justify-center', className)} {...p}>{children}
    <div className="absolute top-full left-0 isolate z-50 flex justify-center"><NavP.Viewport data-slot="navigation-menu-viewport" className="origin-top-center bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-90 relative mt-1.5 h-[var(--radix-navigation-menu-viewport-height)] w-full overflow-hidden rounded-md border shadow md:w-[var(--radix-navigation-menu-viewport-width)]" /></div></NavP.Root>;
}
const NavTrigger = ({ className, children, ...p }) => <NavP.Trigger data-slot="navigation-menu-trigger" className={cn(navTriggerStyle(), 'group', className)} {...p}>{children}{' '}<ChevronDown className="relative top-[1px] ml-1 size-3 transition duration-300 group-data-[state=open]:rotate-180" aria-hidden="true" /></NavP.Trigger>;
const NavContent = ({ className, ...p }) => <NavP.Content data-slot="navigation-menu-content" className={cn('data-[motion^=from-]:animate-in data-[motion^=to-]:animate-out data-[motion^=from-]:fade-in data-[motion^=to-]:fade-out data-[motion=from-end]:slide-in-from-right-52 data-[motion=from-start]:slide-in-from-left-52 data-[motion=to-end]:slide-out-to-right-52 data-[motion=to-start]:slide-out-to-left-52 top-0 left-0 w-full p-2 pr-2.5 md:absolute md:w-auto', className)} {...p} />;
const NavLink = ({ className, ...p }) => <NavP.Link data-slot="navigation-menu-link" className={cn("hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex flex-col gap-1 rounded-sm p-2 text-sm transition-all outline-none", className)} {...p} />;

// ---- the gallery ----
const invoices = Array.from({ length: 12 }, (_, i) => ({ id: 'INV' + String(i + 1).padStart(3, '0'), status: ['Paid', 'Pending', 'Unpaid'][i % 3], method: ['Credit Card', 'PayPal', 'Bank Transfer'][i % 3], amount: (250 + i * 37.5).toFixed(2) }));
const frameworks = [{ value: 'next.js', label: 'Next.js' }, { value: 'sveltekit', label: 'SvelteKit' }, { value: 'nuxt.js', label: 'Nuxt.js' }, { value: 'remix', label: 'Remix' }, { value: 'astro', label: 'Astro' }];
const tags = Array.from({ length: 40 }, (_, i) => 'v1.2.0-beta.' + (40 - i));
const avatarSvg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#6366f1"/><circle cx="32" cy="25" r="12" fill="#e0e7ff"/><rect x="12" y="42" width="40" height="22" rx="11" fill="#e0e7ff"/></svg>');

function Section({ id, title, children, className }) { return <section id={'s-' + id} data-demo={id} className={cn('bg-card text-card-foreground flex flex-col gap-3 rounded-xl border p-4 shadow-sm', className)}><h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{title}</h3><div className="flex flex-1 flex-col gap-3">{children}</div></section>; }

function TableDemo() {
  const [q, setQ] = React.useState(''); const [sel, setSel] = React.useState(null);
  const rows = invoices.filter((r) => !q || r.status.toLowerCase().includes(q.toLowerCase()));
  return <div className="flex flex-col gap-2"><Input id="q" placeholder="Filter status..." value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
    <div data-slot="table-container" className="relative w-full overflow-x-auto"><table data-slot="table" className="w-full caption-bottom text-sm">
      <thead data-slot="table-header" className="[&_tr]:border-b"><tr className="hover:bg-muted/50 border-b transition-colors">{['Invoice', 'Status', 'Method', 'Amount'].map((h, i) => <th key={h} className={cn('text-foreground h-10 px-2 text-left align-middle font-medium whitespace-nowrap', i === 3 && 'text-right')}>{h}</th>)}</tr></thead>
      <tbody data-slot="table-body" className="[&_tr:last-child]:border-0">{rows.slice(0, 6).map((r) => <tr key={r.id} data-slot="table-row" onClick={() => setSel(r.id)} data-state={sel === r.id ? 'selected' : undefined} className="hover:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors">
        <td className="p-2 align-middle whitespace-nowrap font-medium">{r.id}</td><td className="p-2 align-middle whitespace-nowrap"><Badge variant={r.status === 'Paid' ? 'default' : r.status === 'Pending' ? 'secondary' : 'destructive'}>{r.status}</Badge></td><td className="p-2 align-middle whitespace-nowrap">{r.method}</td><td className="p-2 align-middle whitespace-nowrap text-right">${r.amount}</td></tr>)}</tbody></table></div></div>;
}

function ComboboxDemo() {
  const [open, setOpen] = React.useState(false); const [value, setValue] = React.useState('');
  return <PopoverP.Root open={open} onOpenChange={setOpen}><PopoverP.Trigger asChild><Button id="combo" variant="outline" role="combobox" aria-expanded={open} className="w-[200px] justify-between">{value ? frameworks.find((f) => f.value === value)?.label : 'Select framework...'}<ChevronsUpDown className="opacity-50" /></Button></PopoverP.Trigger>
    <PopoverContent className="w-[200px] p-0"><Command><CommandInput placeholder="Search framework..." className="h-9" /><CommandList><CommandEmpty>No framework found.</CommandEmpty><CommandGroup>
      {frameworks.map((f) => <CommandItem key={f.value} value={f.value} onSelect={(v) => { setValue(v === value ? '' : v); setOpen(false); }}>{f.label}<Check className={cn('ml-auto', value === f.value ? 'opacity-100' : 'opacity-0')} /></CommandItem>)}</CommandGroup></CommandList></Command></PopoverContent></PopoverP.Root>;
}

function App() {
  const [dialog, setDialog] = React.useState(false);
  const [progress, setProgress] = React.useState(13);
  const [date, setDate] = React.useState(new Date(2026, 0, 12));
  const [menuCheck, setMenuCheck] = React.useState(true);
  const [menuPos, setMenuPos] = React.useState('bottom');
  const [collapsed, setCollapsed] = React.useState(false);
  const [page, setPage] = React.useState(2);
  const [otp, setOtp] = React.useState('');
  const [fruit, setFruit] = React.useState('');
  const [alertDone, setAlertDone] = React.useState(false);
  const [cmVal, setCmVal] = React.useState(null);
  return <TooltipP.Provider delayDuration={0}><div className="p-6 grid grid-cols-3 gap-4 items-start">
    <Section id="button" title="Button · Badge · Kbd">
      <div className="flex flex-wrap items-center gap-2"><Button>Default</Button><Button variant="secondary">Secondary</Button><Button variant="outline">Outline</Button><Button variant="ghost">Ghost</Button><Button variant="destructive" size="sm">Delete</Button><Button variant="link">Link</Button><Button size="icon" variant="outline" aria-label="Next"><ChevronRight /></Button></div>
      <div className="flex flex-wrap items-center gap-2"><Badge>Badge</Badge><Badge variant="secondary">Secondary</Badge><Badge variant="destructive">Destructive</Badge><Badge variant="outline"><Check />Verified</Badge><span className="text-sm">Press <Kbd>⌘</Kbd><Kbd>K</Kbd></span></div>
    </Section>
    <Section id="card" title="Card · Input · Label">
      <Card className="gap-4 py-4"><CardHeader className="px-4"><CardTitle>Login to your account</CardTitle><CardDescription>Enter your email below</CardDescription></CardHeader>
        <CardContent className="px-4 grid gap-2"><Label htmlFor="email">Email</Label><Input id="email" type="email" placeholder="m@example.com" /></CardContent><CardFooter className="px-4"><Button className="w-full">Login</Button></CardFooter></Card>
    </Section>
    <Section id="alert" title="Alert">
      <Alert><Terminal /><AlertTitle>Heads up!</AlertTitle><AlertDescription>You can add components with the CLI.</AlertDescription></Alert>
      <Alert variant="destructive"><AlertCircle /><AlertTitle>Error</AlertTitle><AlertDescription><p>Your session has expired. Please log in again.</p></AlertDescription></Alert>
    </Section>
    <Section id="accordion" title="Accordion">
      <Accordion type="single" collapsible defaultValue="item-1" className="w-full">
        <AccordionItem value="item-1"><AccordionTrigger id="acc-1">Is it accessible?</AccordionTrigger><AccordionContent>Yes. It adheres to the WAI-ARIA design pattern.</AccordionContent></AccordionItem>
        <AccordionItem value="item-2"><AccordionTrigger id="acc-2">Is it styled?</AccordionTrigger><AccordionContent>Yes. It comes with default styles that match the other components.</AccordionContent></AccordionItem>
        <AccordionItem value="item-3"><AccordionTrigger id="acc-3">Is it animated?</AccordionTrigger><AccordionContent>Yes. It is animated by default.</AccordionContent></AccordionItem>
      </Accordion>
    </Section>
    <Section id="tabs" title="Tabs">
      <TabsP.Root defaultValue="account" data-slot="tabs" className="flex flex-col gap-2">
        <TabsP.List data-slot="tabs-list" className="bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-lg p-[3px]">{['account', 'password'].map((v) => <TabsP.Trigger key={v} value={v} id={'t-' + v} data-slot="tabs-trigger" className="data-[state=active]:bg-background text-foreground inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] data-[state=active]:shadow-sm capitalize">{v}</TabsP.Trigger>)}</TabsP.List>
        <TabsP.Content value="account" data-slot="tabs-content" className="flex-1 outline-none grid gap-2"><Label htmlFor="tab-name">Name</Label><Input id="tab-name" defaultValue="Pedro Duarte" /></TabsP.Content>
        <TabsP.Content value="password" data-slot="tabs-content" className="flex-1 outline-none grid gap-2"><Label htmlFor="tab-pw">New password</Label><Input id="tab-pw" type="password" /><Button className="w-fit" size="sm">Save password</Button></TabsP.Content>
      </TabsP.Root>
    </Section>
    <Section id="controls" title="Checkbox · Switch · Radio group">
      <div className="flex items-center gap-3"><Checkbox id="terms" /><Label htmlFor="terms">Accept terms and conditions</Label></div>
      <div className="flex items-center gap-3"><Switch id="airplane" /><Label htmlFor="airplane">Airplane mode</Label></div>
      <RadioGroup defaultValue="comfortable" className="flex gap-4">{['default', 'comfortable', 'compact'].map((v) => <div key={v} className="flex items-center gap-2"><RadioGroupItem value={v} id={'r-' + v} /><Label htmlFor={'r-' + v} className="capitalize">{v}</Label></div>)}</RadioGroup>
    </Section>
    <Section id="select" title="Select">
      <SelectP.Root value={fruit} onValueChange={setFruit}><SelectTrigger id="select" className="w-[180px]"><SelectP.Value placeholder="Select a fruit" /></SelectTrigger>
        <SelectContent><SelectP.Group><SelectP.Label className="text-muted-foreground px-2 py-1.5 text-xs">Fruits</SelectP.Label>{['Apple', 'Banana', 'Blueberry', 'Grapes', 'Pineapple'].map((f) => <SelectItem key={f} value={f.toLowerCase()}>{f}</SelectItem>)}</SelectP.Group></SelectContent></SelectP.Root>
      <Label>Slider</Label><Slider id="slider" defaultValue={[50]} max={100} step={1} className="w-[60%]" />
      <Label>Progress</Label><div className="flex items-center gap-2"><Progress value={progress} className="w-[60%]" /><Button id="progress" size="sm" variant="outline" onClick={() => setProgress((v) => Math.min(100, v + 33))}>+33</Button></div>
    </Section>
    <Section id="toggle" title="Toggle · Toggle group">
      <div className="flex gap-2"><Toggle id="toggle" aria-label="Toggle italic" variant="outline"><Italic /> Italic</Toggle></div>
      <ToggleGroup type="multiple" variant="outline" id="tgroup"><ToggleGroupItem value="bold" aria-label="Bold"><Bold /></ToggleGroupItem><ToggleGroupItem value="italic" aria-label="Italic"><Italic /></ToggleGroupItem><ToggleGroupItem value="underline" aria-label="Underline"><Underline /></ToggleGroupItem></ToggleGroup>
      <Separator />
      <div className="flex h-5 items-center gap-4 text-sm"><div>Blog</div><Separator orientation="vertical" /><div>Docs</div><Separator orientation="vertical" /><div>Source</div></div>
    </Section>
    <Section id="avatar" title="Avatar · Skeleton">
      <div className="flex items-center gap-3"><Avatar><AvatarImage src={avatarSvg} alt="user" /><AvatarFallback>CN</AvatarFallback></Avatar><Avatar><AvatarFallback>ER</AvatarFallback></Avatar>
        <div className="flex -space-x-2 *:data-[slot=avatar]:ring-background *:data-[slot=avatar]:ring-2">{['AB', 'CD', 'EF'].map((t) => <Avatar key={t}><AvatarFallback>{t}</AvatarFallback></Avatar>)}</div></div>
      <div className="flex items-center gap-4"><Skeleton className="h-12 w-12 rounded-full" /><div className="space-y-2"><Skeleton className="h-4 w-[160px]" /><Skeleton className="h-4 w-[120px]" /></div></div>
    </Section>
    <Section id="overlays" title="Dialog · Alert dialog · Sheet · Drawer">
      <div className="flex flex-wrap gap-2">
        <DialogP.Root open={dialog} onOpenChange={setDialog}><DialogP.Trigger asChild><Button variant="outline" id="dopen">Edit profile</Button></DialogP.Trigger>
          <DialogContent><DialogHeader><DialogTitle>Edit profile</DialogTitle><DialogDescription>Make changes to your profile here.</DialogDescription></DialogHeader>
            <div className="grid gap-3"><Label htmlFor="nm">Name</Label><Input id="nm" defaultValue="Pedro Duarte" /></div>
            <DialogFooter><Button variant="outline" onClick={() => setDialog(false)}>Cancel</Button><Button onClick={() => setDialog(false)}>Save changes</Button></DialogFooter></DialogContent></DialogP.Root>
        <AlertDialogP.Root><AlertDialogP.Trigger asChild><Button variant="outline" id="aopen">Delete account</Button></AlertDialogP.Trigger>
          <AlertDialogContent><div className="flex flex-col gap-2 text-center sm:text-left"><AlertDialogP.Title className="text-lg font-semibold">Are you absolutely sure?</AlertDialogP.Title><AlertDialogP.Description className="text-muted-foreground text-sm">This action cannot be undone.</AlertDialogP.Description></div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><AlertDialogP.Cancel className={buttonVariants({ variant: 'outline' })}>Cancel</AlertDialogP.Cancel><AlertDialogP.Action id="aok" className={buttonVariants()} onClick={() => setAlertDone(true)}>Continue</AlertDialogP.Action></div></AlertDialogContent></AlertDialogP.Root>
        <DialogP.Root><DialogP.Trigger asChild><Button variant="outline" id="sopen">Open sheet</Button></DialogP.Trigger>
          <SheetContent><div className="flex flex-col gap-1.5 p-4"><DialogP.Title className="text-foreground font-semibold">Edit profile</DialogP.Title><DialogP.Description className="text-muted-foreground text-sm">Click save when you're done.</DialogP.Description></div>
            <div className="grid flex-1 auto-rows-min gap-6 px-4"><div className="grid gap-3"><Label htmlFor="sheet-name">Name</Label><Input id="sheet-name" defaultValue="Pedro Duarte" /></div></div>
            <div className="mt-auto flex flex-col gap-2 p-4"><Button>Save changes</Button></div></SheetContent></DialogP.Root>
        <DrawerP.Root><DrawerP.Trigger asChild><Button variant="outline" id="dropen">Open drawer</Button></DrawerP.Trigger>
          <DrawerContent><div className="mx-auto w-full max-w-sm"><div className="flex flex-col gap-1.5 p-4 text-center"><DrawerP.Title className="text-foreground font-semibold">Move goal</DrawerP.Title><DrawerP.Description className="text-muted-foreground text-sm">Set your daily activity goal.</DrawerP.Description></div>
            <div className="flex items-center justify-center gap-2 p-4"><Button variant="outline" size="icon" className="rounded-full"><Minus /></Button><div className="text-6xl font-bold tracking-tighter">350</div><Button variant="outline" size="icon" className="rounded-full">+</Button></div>
            <div className="flex flex-col gap-2 p-4"><DrawerP.Close asChild><Button id="drclose" variant="outline">Cancel</Button></DrawerP.Close></div></div></DrawerContent></DrawerP.Root>
      </div>
      <div className="text-muted-foreground text-sm">Alert dialog: <span id="alert-result">{alertDone ? 'confirmed' : 'not confirmed'}</span></div>
    </Section>
    <Section id="popovers" title="Popover · Tooltip · Hover card">
      <div className="flex flex-wrap items-center gap-2">
        <PopoverP.Root><PopoverP.Trigger asChild><Button variant="outline" id="popen">Open popover</Button></PopoverP.Trigger>
          <PopoverContent><div className="grid gap-4"><div className="space-y-2"><h4 className="leading-none font-medium">Dimensions</h4><p className="text-muted-foreground text-sm">Set the dimensions for the layer.</p></div>
            <div className="grid grid-cols-3 items-center gap-4"><Label htmlFor="width">Width</Label><Input id="width" defaultValue="100%" className="col-span-2 h-8" /></div></div></PopoverContent></PopoverP.Root>
        <TooltipP.Root><TooltipP.Trigger asChild><Button variant="outline" id="tip">Hover</Button></TooltipP.Trigger><TooltipContent><p>Add to library</p></TooltipContent></TooltipP.Root>
        <HoverCardP.Root openDelay={50} closeDelay={50}><HoverCardP.Trigger asChild><Button variant="link" id="hover">@nextjs</Button></HoverCardP.Trigger>
          <HoverCardContent className="w-80"><div className="flex justify-between gap-4"><Avatar><AvatarFallback>VC</AvatarFallback></Avatar><div className="space-y-1"><h4 className="text-sm font-semibold">@nextjs</h4><p className="text-sm">The React Framework – created and maintained by @vercel.</p><div className="text-muted-foreground text-xs">Joined December 2021</div></div></div></HoverCardContent></HoverCardP.Root>
      </div>
    </Section>
    <Section id="menus" title="Dropdown menu · Context menu · Menubar">
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenuP.Root><DropdownMenuP.Trigger asChild><Button variant="outline" id="dm">Open menu</Button></DropdownMenuP.Trigger>
          <DM.Content className="w-56" align="start"><DM.Label>My Account</DM.Label><DropdownMenuP.Group><DM.Item>Profile<DM.Shortcut>⇧⌘P</DM.Shortcut></DM.Item><DM.Item>Billing<DM.Shortcut>⌘B</DM.Shortcut></DM.Item></DropdownMenuP.Group><DM.Separator />
            <DM.CheckboxItem id="dm-check" checked={menuCheck} onCheckedChange={setMenuCheck}>Status bar</DM.CheckboxItem>
            <DropdownMenuP.Sub><DM.SubTrigger id="dm-sub">Panel position</DM.SubTrigger><DM.SubContent><DropdownMenuP.RadioGroup value={menuPos} onValueChange={setMenuPos}>{['top', 'bottom', 'right'].map((v) => <DM.RadioItem key={v} value={v} id={'dm-' + v} className="capitalize">{v}</DM.RadioItem>)}</DropdownMenuP.RadioGroup></DM.SubContent></DropdownMenuP.Sub>
            <DM.Separator /><DM.Item variant="destructive">Log out</DM.Item></DM.Content></DropdownMenuP.Root>
        <MenubarP.Root data-slot="menubar" className="bg-background flex h-9 items-center gap-1 rounded-md border p-1 shadow-xs">{[['File', ['New Tab', 'New Window', 'Print...']], ['Edit', ['Undo', 'Redo', 'Cut']], ['View', ['Reload', 'Full Screen']]].map(([m, items]) =>
          <MenubarP.Menu key={m} value={m}><MenubarP.Trigger id={'mb-' + m} data-slot="menubar-trigger" className="focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground flex items-center rounded-sm px-2 py-1 text-sm font-medium outline-hidden select-none">{m}</MenubarP.Trigger>
            <MB.Content align="start" alignOffset={-4} sideOffset={8} className="min-w-[12rem]">{items.map((t, i) => <MB.Item key={t}>{t}{i === 0 && <MB.Shortcut>⌘T</MB.Shortcut>}</MB.Item>)}</MB.Content></MenubarP.Menu>)}</MenubarP.Root>
      </div>
      <ContextMenuP.Root><ContextMenuP.Trigger id="ctx" className="flex h-[90px] w-full items-center justify-center rounded-md border border-dashed text-sm">Right click here</ContextMenuP.Trigger>
        <CM.Content className="w-52"><CM.Item inset onSelect={() => setCmVal('back')}>Back<CM.Shortcut>⌘[</CM.Shortcut></CM.Item><CM.Item inset disabled>Forward</CM.Item><CM.Item inset id="cm-reload" onSelect={() => setCmVal('reload')}>Reload<CM.Shortcut>⌘R</CM.Shortcut></CM.Item><CM.Separator /><CM.CheckboxItem checked>Show bookmarks</CM.CheckboxItem></CM.Content></ContextMenuP.Root>
      <div className="text-muted-foreground text-sm">Context menu: <span id="cm-result">{cmVal || 'nothing chosen'}</span> · Panel: <span id="dm-result">{menuPos}</span>, status bar <span id="dm-status">{menuCheck ? 'on' : 'off'}</span></div>
    </Section>
    <Section id="command" title="Command · Combobox">
      <Command className="rounded-lg border shadow-md"><CommandInput placeholder="Type a command or search..." /><CommandList className="max-h-[180px]"><CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Suggestions"><CommandItem><CalendarIcon /><span>Calendar</span></CommandItem><CommandItem><Search /><span>Search Emoji</span></CommandItem><CommandItem disabled><span>Calculator</span></CommandItem></CommandGroup><CommandSeparator />
        <CommandGroup heading="Settings"><CommandItem><span>Profile</span><span className={shortcutCls}>⌘P</span></CommandItem><CommandItem><span>Billing</span><span className={shortcutCls}>⌘B</span></CommandItem><CommandItem><span>Settings</span><span className={shortcutCls}>⌘S</span></CommandItem></CommandGroup></CommandList></Command>
      <ComboboxDemo />
    </Section>
    <Section id="calendar" title="Calendar">
      <Calendar mode="single" defaultMonth={new Date(2026, 0, 1)} selected={date} onSelect={setDate} className="rounded-md border shadow-sm" />
    </Section>
    <Section id="collapsible" title="Collapsible · Scroll area">
      <Collapsible open={collapsed} onOpenChange={setCollapsed} className="flex flex-col gap-2"><div className="flex items-center justify-between gap-4 px-2"><h4 className="text-sm font-semibold">@peduarte starred 3 repositories</h4><CollapsibleP.Trigger asChild><Button id="coll" variant="ghost" size="icon" className="size-8"><ChevronsUpDown /><span className="sr-only">Toggle</span></Button></CollapsibleP.Trigger></div>
        <div className="rounded-md border px-4 py-2 font-mono text-sm">@radix-ui/primitives</div><CollapsibleP.Content data-slot="collapsible-content" className="flex flex-col gap-2"><div className="rounded-md border px-4 py-2 font-mono text-sm">@radix-ui/colors</div><div className="rounded-md border px-4 py-2 font-mono text-sm">@stitches/react</div></CollapsibleP.Content></Collapsible>
      <ScrollArea id="scroll" className="h-40 w-full rounded-md border"><div className="p-4"><h4 className="mb-4 text-sm leading-none font-medium">Tags</h4>{tags.map((t) => <React.Fragment key={t}><div className="text-sm">{t}</div><Separator className="my-2" /></React.Fragment>)}</div></ScrollArea>
    </Section>
    <Section id="nav" title="Navigation menu · Breadcrumb · Pagination">
      <NavigationMenu id="navm"><NavP.List data-slot="navigation-menu-list" className="group flex flex-1 list-none items-center justify-center gap-1">
        <NavP.Item data-slot="navigation-menu-item" className="relative"><NavTrigger id="nav-start">Getting started</NavTrigger><NavContent><ul className="grid gap-2 w-[300px]">{[['Introduction', 'Re-usable components built using Radix UI and Tailwind CSS.'], ['Installation', 'How to install dependencies and structure your app.']].map(([t, d]) => <li key={t}><NavLink href="#"><div className="text-sm leading-none font-medium">{t}</div><p className="text-muted-foreground line-clamp-2 text-sm leading-snug">{d}</p></NavLink></li>)}</ul></NavContent></NavP.Item>
        <NavP.Item data-slot="navigation-menu-item" className="relative"><NavP.Link href="#" className={navTriggerStyle()}>Docs</NavP.Link></NavP.Item></NavP.List></NavigationMenu>
      <nav aria-label="breadcrumb" data-slot="breadcrumb"><ol className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-sm break-words sm:gap-2.5">
        <li className="inline-flex items-center gap-1.5"><a href="#" className="hover:text-foreground transition-colors">Home</a></li><li role="presentation" aria-hidden="true" className="[&>svg]:size-3.5"><ChevronRight /></li>
        <li className="inline-flex items-center gap-1.5"><MoreHorizontal className="size-4" /></li><li role="presentation" aria-hidden="true" className="[&>svg]:size-3.5"><ChevronRight /></li>
        <li className="inline-flex items-center gap-1.5"><span role="link" aria-disabled="true" aria-current="page" className="text-foreground font-normal">Breadcrumb</span></li></ol></nav>
      <nav role="navigation" aria-label="pagination" data-slot="pagination" className="mx-auto flex w-full justify-center"><ul className="flex flex-row items-center gap-1">
        <li><a href="#" id="pg-prev" aria-label="Go to previous page" onClick={(e) => { e.preventDefault(); setPage((p) => Math.max(1, p - 1)); }} className={cn(buttonVariants({ variant: 'ghost' }), 'gap-1 px-2.5 sm:pl-2.5')}><ChevronLeft /><span className="hidden sm:block">Previous</span></a></li>
        {[1, 2, 3].map((n) => <li key={n}><a href="#" id={'pg-' + n} aria-current={page === n ? 'page' : undefined} data-active={page === n} onClick={(e) => { e.preventDefault(); setPage(n); }} className={cn(buttonVariants({ variant: page === n ? 'outline' : 'ghost', size: 'icon' }))}>{n}</a></li>)}
        <li><span aria-hidden className="flex size-9 items-center justify-center"><MoreHorizontal className="size-4" /></span></li>
        <li><a href="#" id="pg-next" aria-label="Go to next page" onClick={(e) => { e.preventDefault(); setPage((p) => Math.min(3, p + 1)); }} className={cn(buttonVariants({ variant: 'ghost' }), 'gap-1 px-2.5 sm:pr-2.5')}><span className="hidden sm:block">Next</span><ChevronRight /></a></li></ul></nav>
    </Section>
    <Section id="forms" title="Textarea · Input OTP · Sonner">
      <Textarea id="ta" placeholder="Type your message here." />
      <OTPInput id="otp" maxLength={6} value={otp} onChange={setOtp} containerClassName="flex items-center gap-2 has-disabled:opacity-50" className="disabled:cursor-not-allowed" render={undefined}>
        <div data-slot="input-otp-group" className="flex items-center">{[0, 1, 2].map((i) => <InputOTPSlot key={i} index={i} />)}</div><div role="separator"><Minus /></div><div data-slot="input-otp-group" className="flex items-center">{[3, 4, 5].map((i) => <InputOTPSlot key={i} index={i} />)}</div></OTPInput>
      <Button id="toast" variant="outline" className="w-fit" onClick={() => toast('Event has been created', { description: 'Sunday, December 03, 2023 at 9:00 AM', action: { label: 'Undo', onClick: () => {} } })}>Show toast</Button>
    </Section>
    <Section id="table" title="Table" className="col-span-2"><TableDemo /></Section>
  </div><Toaster position="bottom-right" /></TooltipP.Provider>;
}

const root = createRoot(document.getElementById('app'));
root.render(<App />);

// ---- steps: input as a person gives it ----
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
function wait(pred, ms) { const end = Date.now() + (ms || 3000); return new Promise((ok) => { (function f() { if (pred() || Date.now() > end) ok(); else setTimeout(f, 16); })(); }); }
function at(el, dx, dy) { const r = el.getBoundingClientRect(); return { clientX: r.left + (dx == null ? r.width / 2 : dx), clientY: r.top + (dy == null ? r.height / 2 : dy) }; }
function mouse(type, el, o) { const P = type.startsWith('pointer') ? PointerEvent : MouseEvent; el.dispatchEvent(new P(type, Object.assign({ bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: type.endsWith('down') ? 1 : 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }, at(el), o || {}))); }
// press and release with the main button, as a click does (focus first, as the browser's mousedown does)
function press(el, o) { if (!el) throw new Error('nothing to press'); el.scrollIntoView({ block: 'nearest' }); mouse('pointerdown', el, o); mouse('mousedown', el, o); if (el.focus && !(o && o.noFocus)) el.focus({ preventScroll: true }); mouse('pointerup', el, o); mouse('mouseup', el, o); mouse('click', el, o); }
// a press on the page's blank corner (outside every open layer)
function pressOutside() { press(document.body, { clientX: 3, clientY: 3, noFocus: true }); }
function down(el, o) { mouse('pointerdown', el, o); mouse('mousedown', el, o); }
function hover(el) { for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) mouse(t, el, { buttons: 0 }); }
// leave, then move on the page once the layer has had its render (Radix tooltip
// tracks the pointer against a grace area from a listener its effect adds)
function unhover(el) { for (const t of ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']) mouse(t, el, { buttons: 0, clientX: 1, clientY: 1 }); return new Promise((ok) => setTimeout(ok, 30)).then(() => { for (const t of ['pointermove', 'mousemove']) mouse(t, document.body, { buttons: 0, clientX: 1, clientY: 1 }); }); }
function key(k, el) { el = el || document.activeElement || document.body; const o = { key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, bubbles: true, cancelable: true, composed: true }; const ok = el.dispatchEvent(new KeyboardEvent('keydown', o)); el.dispatchEvent(new KeyboardEvent('keyup', o)); return ok; }
function type(el, text) { el.focus(); for (const ch of text) { key(ch, el); document.execCommand('insertText', false, ch); } }
const open = (s) => !!$(s);
const scrollTo = (id) => { const e = $('#s-' + id); if (e) e.scrollIntoView({ block: 'start' }); };

const settle = (r) => Promise.resolve(r).then(() => new Promise((ok) => setTimeout(ok, 0)));
const steps = [
    { name: 'accordion: open item 2', run: () => { scrollTo('accordion'); press($('#acc-2')); return wait(() => $('#acc-2').getAttribute('data-state') === 'open'); } },
    { name: 'tabs: password (arrow key)', run: () => { press($('#t-account')); key('ArrowRight'); return wait(() => $('#t-password').getAttribute('data-state') === 'active'); } },
    { name: 'checkbox + switch + radio', run: () => { scrollTo('controls'); press($('#terms')); press($('#airplane')); press($('#r-compact')); } },
    { name: 'select: open', run: () => { scrollTo('select'); down($('#select'), { pointerType: 'mouse' }); return wait(() => open('[data-slot=select-content]')); } },
    { name: 'select: choose Grapes', run: () => { const it = $$('[data-slot=select-item]').find((e) => e.textContent === 'Grapes'); mouse('pointermove', it); press(it); return wait(() => !open('[data-slot=select-content]')); } },
    { name: 'slider: PageUp, ArrowLeft x2', run: () => { const th = $('[data-slot=slider-thumb]'); th.focus(); key('PageUp', th); key('ArrowLeft', th); key('ArrowLeft', th); } },
    { name: 'progress +33', run: () => press($('#progress')) },
    { name: 'toggle + toggle group', run: () => { scrollTo('toggle'); press($('#toggle')); press($$('#tgroup [data-slot=toggle-group-item]')[0]); press($$('#tgroup [data-slot=toggle-group-item]')[2]); } },
    { name: 'dialog: open', run: () => { press($('#dopen')); return wait(() => open('[data-slot=dialog-content]')); } },
    { name: 'dialog: type, Escape', run: () => { type($('#nm'), ' Jr'); key('Escape'); return wait(() => !open('[data-slot=dialog-content]')); } },
    { name: 'alert dialog: open', run: () => { press($('#aopen')); return wait(() => open('[data-slot=alert-dialog-content]')); } },
    { name: 'alert dialog: continue', run: () => { press($('#aok')); return wait(() => !open('[data-slot=alert-dialog-content]')); } },
    { name: 'sheet: open', run: () => { press($('#sopen')); return wait(() => open('[data-slot=sheet-content]')); } },
    { name: 'sheet: close', run: () => { press($('#sheet-close')); return wait(() => !open('[data-slot=sheet-content]')); } },
    { name: 'drawer: open', run: () => { press($('#dropen')); return wait(() => open('[data-slot=drawer-content]')); } },
    { name: 'drawer: close', run: () => { press($('#drclose')); return wait(() => !open('[data-slot=drawer-content]'), 3000); } },
    { name: 'popover: open', run: () => { scrollTo('popovers'); press($('#popen')); return wait(() => open('[data-slot=popover-content]')); } },
    { name: 'popover: outside press closes', run: () => { pressOutside(); return wait(() => !open('[data-slot=popover-content]')); } },
    { name: 'tooltip: hover', run: () => { hover($('#tip')); return wait(() => open('[data-slot=tooltip-content]')); } },
    { name: 'tooltip: leave', run: () => { return unhover($('#tip')).then(() => wait(() => !open('[data-slot=tooltip-content]'))); } },
    { name: 'hover card: hover', run: () => { hover($('#hover')); return wait(() => open('[data-slot=hover-card-content]')); } },
    { name: 'hover card: leave', run: () => { return unhover($('#hover')).then(() => wait(() => !open('[data-slot=hover-card-content]'))); } },
    { name: 'dropdown menu: open', run: () => { scrollTo('menus'); down($('#dm')); return wait(() => open('[data-slot=dropdown-menu-content]')); } },
    { name: 'dropdown menu: submenu (ArrowRight)', run: () => { const s = $('#dm-sub'); s.focus(); key('ArrowRight', s); return wait(() => open('[data-slot=dropdown-menu-sub-content]')); } },
    { name: 'dropdown menu: choose Right', run: () => { press($('#dm-right')); return wait(() => !open('[data-slot=dropdown-menu-content]')); } },
    { name: 'menubar: open File', run: () => { down($('#mb-File')); mouse('pointerup', $('#mb-File')); mouse('mouseup', $('#mb-File')); return wait(() => open('[data-slot=menubar-content]')); } },
    { name: 'menubar: ArrowDown x2', run: () => { key('ArrowDown'); key('ArrowDown'); } },
    { name: 'menubar: Escape', run: () => { key('Escape'); return wait(() => !open('[data-slot=menubar-content]')); } },
    { name: 'context menu: right click', run: () => { const c = $('#ctx'); mouse('pointerdown', c, { button: 2, buttons: 2 }); c.dispatchEvent(new MouseEvent('contextmenu', Object.assign({ bubbles: true, cancelable: true, button: 2 }, at(c, 40, 30)))); return wait(() => open('[data-slot=context-menu-content]')); } },
    { name: 'context menu: Reload', run: () => { press($('#cm-reload')); return wait(() => !open('[data-slot=context-menu-content]')); } },
    { name: 'command: type "set"', run: () => { scrollTo('command'); type($('#s-command [data-slot=command-input]'), 'set'); } },
    { name: 'command: ArrowDown', run: () => key('ArrowDown', $('#s-command [data-slot=command-input]')) },
    { name: 'combobox: open', run: () => { press($('#combo')); return wait(() => open('[data-slot=popover-content] [data-slot=command-input]')); } },
    { name: 'combobox: type "re", Enter', run: () => { const i = $('[data-slot=popover-content] [data-slot=command-input]'); type(i, 're'); key('Enter', i); return wait(() => !open('[data-slot=popover-content]')); } },
    { name: 'calendar: next month', run: () => { scrollTo('calendar'); press($('[data-demo=calendar] .rdp-button_next, [data-demo=calendar] button[aria-label*=next i]')); } },
    { name: 'calendar: pick the 18th', run: () => press($$('[data-demo=calendar] [data-day]').find((b) => b.getAttribute('data-day') === '2/18/2026')) },
    { name: 'collapsible: open', run: () => { scrollTo('collapsible'); press($('#coll')); } },
    { name: 'scroll area: wheel', run: () => { const v = $('[data-slot=scroll-area-viewport]'); v.scrollTop = 200; v.dispatchEvent(new Event('scroll')); } },
    { name: 'navigation menu: open', run: () => { scrollTo('nav'); press($('#nav-start')); return wait(() => open('[data-slot=navigation-menu-content]')); } },
    { name: 'navigation menu: Escape', run: () => { key('Escape', $('#nav-start')); return wait(() => !open('[data-slot=navigation-menu-content]')); } },
    { name: 'pagination: page 3, previous', run: () => { press($('#pg-3')); press($('#pg-prev')); } },
    { name: 'textarea: type', run: () => { scrollTo('forms'); type($('#ta'), 'Hello there'); } },
    { name: 'input OTP: type 123456', run: () => { const i = $('[data-input-otp]') || $('#otp'); type(i, '123456'); } },
    { name: 'sonner: show toast', run: () => { press($('#toast')); return wait(() => open('[data-sonner-toast]')); } },
    { name: 'table: filter "pend"', run: () => { scrollTo('table'); type($('#q'), 'pend'); } },
    { name: 'table: select a row', run: () => press($$('[data-demo=table] tbody tr')[1]) },
];
window.__benchCase = {
  setup: () => wait(() => !!$('[data-demo=table] tbody tr')),
  steps: steps.map((s) => ({ name: s.name, run: () => settle(s.run()) })),
  probe: () => {
    const st = (s) => { const e = $(s); return e ? e.getAttribute('data-state') : null; };
    const txt = (s) => { const e = $(s); return e ? e.textContent : null; };
    const thumb = $('[data-slot=slider-thumb]');
    return {
      accordion: $$('[data-slot=accordion-item]').map((e) => e.getAttribute('data-state')).join(','),
      tab: txt('[data-slot=tabs-trigger][data-state=active]'),
      controls: [st('#terms'), st('#airplane'), st('[data-slot=radio-group-item][data-state=checked]') && $('[data-slot=radio-group-item][data-state=checked]').value].join(','),
      select: txt('[data-slot=select-trigger] [data-slot=select-value], [data-slot=select-trigger] span'),
      slider: thumb ? thumb.getAttribute('aria-valuenow') : null,
      progress: ($('[data-slot=progress-indicator]') || { style: {} }).style.transform,
      toggles: [st('#toggle')].concat($$('#tgroup [data-slot=toggle-group-item]').map((e) => e.getAttribute('data-state'))).join(','),
      layers: ['dialog', 'alert-dialog', 'sheet', 'drawer', 'popover', 'tooltip', 'hover-card', 'dropdown-menu', 'dropdown-menu-sub', 'menubar', 'context-menu', 'select', 'navigation-menu'].filter((s) => open('[data-slot=' + s + '-content]')).join(','),
      focusIn: (document.activeElement && (document.activeElement.id || document.activeElement.getAttribute('data-slot') || document.activeElement.tagName)) || null,
      alert: txt('#alert-result'), contextMenu: txt('#cm-result'),
      menu: txt('#dm-result') + ',' + txt('#dm-status'),
      command: $$('[data-slot=command] [data-slot=command-item]').filter((e) => !e.closest('[data-slot=popover-content]')).map((e) => (e.getAttribute('data-selected') === 'true' ? '*' : '') + e.textContent).join('|'),
      combobox: txt('#combo'),
      calendar: [txt('[data-demo=calendar] .rdp-caption_label, [data-demo=calendar] [role=status]'), ($('[data-demo=calendar] [data-selected-single=true]') || {}).textContent || null].join(','),
      collapsible: st('[data-slot=collapsible]'), scroll: ($('[data-slot=scroll-area-viewport]') || {}).scrollTop | 0,
      page: txt('[data-slot=pagination] [aria-current=page]'), textarea: ($('#ta') || {}).value, otp: $$('[data-slot=input-otp-slot]').map((e) => e.textContent).join(''),
      toasts: $$('[data-sonner-toast]').length,
      rows: $$('[data-demo=table] tbody tr').length, selected: txt('[data-demo=table] tr[data-state=selected] td'),
    };
  },
};
