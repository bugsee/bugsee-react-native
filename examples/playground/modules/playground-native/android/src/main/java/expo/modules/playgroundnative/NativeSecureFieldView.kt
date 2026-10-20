package expo.modules.playgroundnative

import android.content.Context
import android.text.InputType
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.EditText
import android.widget.LinearLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

class NativeSecureFieldView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  // Children added natively are not measured by React Native; let Android lay them out inside Yoga's bounds.
  override val shouldUseAndroidLayout = true

  private val column = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT)
  }

  private fun row() = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT)

  init {
    column.addView(EditText(context).apply {
      hint = "Native secure field"
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
    }, row())
    column.addView(EditText(context).apply {
      hint = "Native plain field"
    }, row())
    addView(column)
  }
}
