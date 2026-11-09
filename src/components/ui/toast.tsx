"use client"

import { Toast as ToastPrimitive } from "@base-ui/react/toast"
import { chromeIcon, XIcon } from "@/components/chrome-icons"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/cn"

/**
 * The shadcn base-ui toast uses fumadocs' fd-* tokens to follow the site
 * theme and dark mode. Call toast.add(...) from anywhere; Toaster mounts
 * once in the root route.
 */
const toast = ToastPrimitive.createToastManager()

const TOAST_ICONS = {
    success: { Icon: chromeIcon("circle-check"), className: "text-fd-success" },
    info: { Icon: chromeIcon("info"), className: "text-fd-info" },
    error: { Icon: chromeIcon("circle-x"), className: "text-fd-error" },
}

/** The toast's glyphs draw at stroke width 2, heavier than the map's 1.5. */
const TOAST_STROKE = "[&_[stroke]]:stroke-2"

function ToastList() {
    const { toasts } = ToastPrimitive.useToastManager()

    return toasts.map((toastItem) => {
        const icon =
            toastItem.type === "success" ||
            toastItem.type === "info" ||
            toastItem.type === "error"
                ? TOAST_ICONS[toastItem.type]
                : null
        return (
            <ToastPrimitive.Root
                key={toastItem.id}
                toast={toastItem}
                className={cn(
                    "group/toast pointer-events-auto absolute right-0 bottom-0 z-[calc(1000-var(--toast-index))] w-full origin-bottom rounded-lg border bg-fd-popover text-fd-popover-foreground shadow-lg will-change-transform outline-none select-none focus-visible:ring-2 focus-visible:ring-fd-ring",
                    "[--gap:0.75rem] [--height:var(--toast-frontmost-height,var(--toast-height))] [--offset-y:calc(var(--toast-offset-y)*-1+calc(var(--toast-index)*var(--gap)*-1)+var(--toast-swipe-movement-y))] [--peek:0.75rem] [--scale:calc(max(0,1-(var(--toast-index)*0.1)))] [--shrink:calc(1-var(--scale))]",
                    "h-(--height) [transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))] [transition:transform_500ms_cubic-bezier(0.22,1,0.36,1),opacity_500ms,height_150ms]",
                    "after:absolute after:top-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-['']",
                    "data-expanded:h-(--toast-height) data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))]",
                    "data-limited:opacity-0 data-starting-style:[transform:translateY(150%)]",
                    "[&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(150%)]",
                    "data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
                    "data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]",
                    "data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]",
                    "data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]",
                    "data-expanded:data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
                    "data-expanded:data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]",
                    "data-expanded:data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]",
                    "data-expanded:data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]",
                    "motion-reduce:transition-none",
                )}
            >
                <ToastPrimitive.Content className="flex h-full items-center gap-3 overflow-hidden p-4 transition-opacity duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] data-behind:opacity-0 data-expanded:opacity-100">
                    {icon ? (
                        <icon.Icon
                            className={cn(
                                "size-4 shrink-0",
                                TOAST_STROKE,
                                icon.className,
                            )}
                        />
                    ) : null}
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <ToastPrimitive.Title className="text-sm font-medium" />
                        <ToastPrimitive.Description className="text-sm text-fd-muted-foreground" />
                    </div>
                    <ToastPrimitive.Close
                        aria-label="Close"
                        className={cn(
                            buttonVariants({ color: "ghost", size: "icon-xs" }),
                            "shrink-0 text-fd-muted-foreground",
                        )}
                    >
                        <XIcon className={TOAST_STROKE} />
                    </ToastPrimitive.Close>
                </ToastPrimitive.Content>
            </ToastPrimitive.Root>
        )
    })
}

function Toaster() {
    return (
        <ToastPrimitive.Provider toastManager={toast}>
            <ToastPrimitive.Portal>
                <ToastPrimitive.Viewport className="pointer-events-none fixed inset-x-4 bottom-4 z-50 mx-auto w-auto max-w-sm outline-none sm:right-4 sm:left-auto sm:mx-0 sm:w-full">
                    <ToastList />
                </ToastPrimitive.Viewport>
            </ToastPrimitive.Portal>
        </ToastPrimitive.Provider>
    )
}

export { Toaster, toast }
