package dev.codever.client

import android.graphics.Color
import android.os.Bundle
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import io.crates.keyring.Keyring

class MainActivity : TauriActivity() {
  private val systemBarBackground = Color.rgb(0x11, 0x13, 0x0F)

  override fun onCreate(savedInstanceState: Bundle?) {
    Keyring.initializeNdkContext(applicationContext)

    super.onCreate(savedInstanceState)
    WindowCompat.setDecorFitsSystemWindows(window, true)
    val contentView = findViewById<View>(android.R.id.content)
    window.decorView.setBackgroundColor(systemBarBackground)
    contentView.setBackgroundColor(systemBarBackground)
    ViewCompat.setOnApplyWindowInsetsListener(contentView) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
    ViewCompat.requestApplyInsets(contentView)
    configureSystemBars()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) configureSystemBars()
  }

  @Suppress("DEPRECATION")
  private fun configureSystemBars() {
    // Android 15+ makes system bars transparent for edge-to-edge apps. Keep the
    // decor behind them dark and explicitly request light (white) system icons.
    window.statusBarColor = systemBarBackground
    window.navigationBarColor = systemBarBackground
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = false
      isAppearanceLightNavigationBars = false
    }
  }
}
