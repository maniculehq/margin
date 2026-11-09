/**
 * Framework-owned `background.decoration: "windows"` backdrop (§4.2): a set of
 * softly-tinted, rounded window-chrome shapes floating behind the top of the
 * page. Pure JSX + CSS (styled in
 * styles/presets/decorations.css), aria-hidden, and never site code. The
 * fixed layer sits below the docs content via z-index (see decorations.css).
 */
export function DecorationWindows() {
    return (
        <div className="fd-decoration-windows" aria-hidden="true">
            <span className="fd-decoration-window" />
            <span className="fd-decoration-window" />
            <span className="fd-decoration-window" />
        </div>
    )
}
