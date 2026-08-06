package id.my.anciety.codever.web

import org.junit.Assert.assertEquals
import org.junit.Test

class NativeWebInsetsTest {
    @Test
    fun `uses the largest safe inset on every edge rather than summing overlaps`() {
        assertEquals(
            InsetEdges(left = 18, top = 42, right = 16, bottom = 30),
            resolveNativeWebInsets(
                systemBars = InsetEdges(left = 4, top = 24, right = 6, bottom = 30),
                displayCutout = InsetEdges(left = 18, top = 42, right = 8, bottom = 0),
                mandatoryGestures = InsetEdges(left = 12, top = 0, right = 16, bottom = 24),
                ime = InsetEdges(bottom = 500),
                imeVisible = false,
            ),
        )
    }

    @Test
    fun `visible ime replaces normal bottom safe area without double inset`() {
        assertEquals(
            InsetEdges(left = 12, top = 24, right = 12, bottom = 500),
            resolveNativeWebInsets(
                systemBars = InsetEdges(top = 24, bottom = 30),
                displayCutout = InsetEdges(),
                mandatoryGestures = InsetEdges(left = 12, right = 12, bottom = 24),
                ime = InsetEdges(bottom = 500),
                imeVisible = true,
            ),
        )
    }

    @Test
    fun `hidden ime ignores a stale ime inset`() {
        assertEquals(
            InsetEdges(top = 24, bottom = 30),
            resolveNativeWebInsets(
                systemBars = InsetEdges(top = 24, bottom = 30),
                displayCutout = InsetEdges(),
                mandatoryGestures = InsetEdges(),
                ime = InsetEdges(bottom = 500),
                imeVisible = false,
            ),
        )
    }

    @Test
    fun `keeps the system bottom inset when a floating ime reports less space`() {
        assertEquals(
            InsetEdges(top = 24, bottom = 30),
            resolveNativeWebInsets(
                systemBars = InsetEdges(top = 24, bottom = 30),
                displayCutout = InsetEdges(),
                mandatoryGestures = InsetEdges(),
                ime = InsetEdges(bottom = 10),
                imeVisible = true,
            ),
        )
    }
}
