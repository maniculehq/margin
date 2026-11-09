// Invented glyphs in the Hugeicons Pro export shape: each icon is exported
// as its canonical `<Name>Icon` and as `<Name>StrokeRounded`.
const FakeSquareIcon = [
    [
        "rect",
        {
            x: "4",
            y: "4",
            width: "16",
            height: "16",
            rx: "2",
            stroke: "currentColor",
            strokeWidth: "1.5",
            key: "0",
        },
    ],
]
const FakeCircleIcon = [
    [
        "circle",
        {
            cx: "12",
            cy: "12",
            r: "8",
            stroke: "currentColor",
            strokeWidth: "1.5",
            key: "0",
        },
    ],
]
const FakeLineIcon = [
    [
        "path",
        {
            d: "M4 12H20",
            stroke: "currentColor",
            strokeLinecap: "round",
            strokeWidth: "1.5",
            key: "0",
        },
    ],
]

export {
    FakeSquareIcon,
    FakeSquareIcon as FakeSquareStrokeRounded,
    FakeCircleIcon,
    FakeCircleIcon as FakeCircleStrokeRounded,
    FakeLineIcon,
    FakeLineIcon as FakeLineStrokeRounded,
}
