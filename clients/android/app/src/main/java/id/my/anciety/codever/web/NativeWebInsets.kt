package id.my.anciety.codever.web

internal data class InsetEdges(
    val left: Int = 0,
    val top: Int = 0,
    val right: Int = 0,
    val bottom: Int = 0,
)

/**
 * Selects the native padding around the online Web UI.
 *
 * Insets overlap spatially, so each edge uses the largest applicable value
 * rather than summing them. In particular, a visible IME replaces the normal
 * bottom safe area instead of being added to the navigation/gesture inset.
 */
internal fun resolveNativeWebInsets(
    systemBars: InsetEdges,
    displayCutout: InsetEdges,
    mandatoryGestures: InsetEdges,
    ime: InsetEdges,
    imeVisible: Boolean,
): InsetEdges = InsetEdges(
    left = maxOf(systemBars.left, displayCutout.left, mandatoryGestures.left),
    top = maxOf(systemBars.top, displayCutout.top, mandatoryGestures.top),
    right = maxOf(systemBars.right, displayCutout.right, mandatoryGestures.right),
    bottom = maxOf(
        systemBars.bottom,
        displayCutout.bottom,
        mandatoryGestures.bottom,
        if (imeVisible) ime.bottom else 0,
    ),
)
