package com.almahasibpro.scanner;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.common.InputImage;
import org.json.JSONObject;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends AppCompatActivity {
    private static final int CAMERA_REQUEST = 100;
    private final ExecutorService cameraExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private BarcodeScanner scanner;
    private ProcessCameraProvider cameraProvider;
    private EditText tokenInput;
    private TextView status;
    private Button connect;
    private String pairingToken = "", lastBarcode = "";
    private long lastScanAt;
    private volatile boolean sending, destroyed, pairMode, validating;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_main);
        tokenInput = findViewById(R.id.tokenInput);
        status = findViewById(R.id.statusText);
        connect = findViewById(R.id.connectButton);
        scanner = BarcodeScanning.getClient();
        connect.setOnClickListener(v -> {
            String token = tokenInput.getText().toString().trim();
            if (!token.matches("[a-fA-F0-9]{32}")) { show("أدخل رمز الربط الكامل من شاشة الكاشير أو امسح QR"); return; }
            verifyPairing(token);
        });
        findViewById(R.id.qrPairButton).setOnClickListener(v -> {
            if (validating) return;
            pairMode = true;
            openCamera();
        });
    }

    private void openCamera() {
        ((android.view.inputmethod.InputMethodManager)getSystemService(INPUT_METHOD_SERVICE))
            .hideSoftInputFromWindow(tokenInput.getWindowToken(), 0);
        tokenInput.clearFocus();
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_REQUEST);
        else startCamera();
    }

    private void verifyPairing(String token) {
        if (destroyed || validating) return;
        validating = true;
        show("جارٍ التحقق من الربط…");
        networkExecutor.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection)new URL("https://almahasibpro.onrender.com/api/v1/market/scanner/" + token + "/status").openConnection();
                connection.setConnectTimeout(15000); connection.setReadTimeout(20000);
                int code = connection.getResponseCode();
                runOnUiThread(() -> {
                    if (destroyed) return;
                    if (code == 200) {
                        pairingToken = token; tokenInput.setText(token); pairMode = false;
                        lastBarcode = ""; lastScanAt = 0;
                        openCamera();
                    } else if (code == 410) show("رمز الربط انتهى. أنشئ QR جديدًا من الكاشير.");
                    else show("تعذر التحقق من الربط (" + code + "). حاول مرة أخرى.");
                });
            } catch (Exception e) { show("تعذر الاتصال للتحقق من الربط. تحقق من الإنترنت."); }
            finally { if (connection != null) connection.disconnect(); validating = false; }
        });
    }

    private String pairingQrToken(String value) {
        try {
            android.net.Uri uri = android.net.Uri.parse(value);
            if (!"https".equals(uri.getScheme()) || !"almahasibpro.onrender.com".equals(uri.getHost())
                || uri.getPort() != -1 || !"/market-scanner.html".equals(uri.getPath())) return null;
            String token = uri.getFragment();
            return token != null && token.matches("[a-fA-F0-9]{32}") ? token : null;
        } catch (Exception e) { return null; }
    }

    @Override public void onRequestPermissionsResult(int request, @NonNull String[] permissions, @NonNull int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == CAMERA_REQUEST) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) startCamera();
            else show("إذن الكاميرا مطلوب للمسح. اسمح به ثم اضغط تشغيل القارئ.");
        }
    }

    @androidx.annotation.OptIn(markerClass = androidx.camera.core.ExperimentalGetImage.class)
    private void startCamera() {
        connect.setEnabled(false);
        show("جارٍ تشغيل الكاميرا…");
        ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
        future.addListener(() -> {
            if (destroyed) return;
            try {
                cameraProvider = future.get();
                Preview preview = new Preview.Builder().build();
                preview.setSurfaceProvider(((PreviewView)findViewById(R.id.preview)).getSurfaceProvider());
                ImageAnalysis analysis = new ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build();
                analysis.setAnalyzer(cameraExecutor, image -> {
                    if (destroyed || sending || validating || image.getImage() == null) { image.close(); return; }
                    InputImage input = InputImage.fromMediaImage(image.getImage(), image.getImageInfo().getRotationDegrees());
                    try {
                        scanner.process(input).addOnSuccessListener(barcodes -> {
                            if (destroyed || sending || validating || barcodes.isEmpty()) return;
                            String value = barcodes.get(0).getRawValue();
                            if (pairMode) {
                                if (barcodes.get(0).getFormat() != com.google.mlkit.vision.barcode.common.Barcode.FORMAT_QR_CODE) return;
                                String token = pairingQrToken(value);
                                if (token != null) verifyPairing(token);
                                else show("امسح QR الربط الظاهر في شاشة الكاشير");
                                return;
                            }
                            if (pairingQrToken(value) != null) return;
                            long now = android.os.SystemClock.elapsedRealtime();
                            if (value != null && !value.isEmpty() && (!value.equals(lastBarcode) || now-lastScanAt > 1800)) {
                                lastBarcode = value; lastScanAt = now; send(value);
                            }
                        }).addOnFailureListener(e -> show("تعذرت قراءة الباركود، حاول مرة أخرى"))
                          .addOnCompleteListener(task -> image.close());
                    } catch (Exception e) { image.close(); show("تعذرت قراءة الصورة"); }
                });
                cameraProvider.unbindAll();
                cameraProvider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis);
                show(pairMode ? "وجّه الكاميرا إلى QR الربط في شاشة الكاشير" : "تم الربط — جاهز لمسح باركود المواد");
            } catch (Exception e) { show("تعذر تشغيل الكاميرا. تحقق من الصلاحية وأغلق أي تطبيق يستخدمها."); }
            connect.setEnabled(true);
        }, ContextCompat.getMainExecutor(this));
    }

    private void send(String barcode) {
        if (sending || destroyed || pairMode || validating || pairingToken.isEmpty()) return;
        sending = true;
        final String token = pairingToken;
        show("جارٍ إرسال الباركود…");
        networkExecutor.execute(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = new URL("https://almahasibpro.onrender.com/api/v1/market/scanner/" + URLEncoder.encode(token, "UTF-8") + "/scan");
                connection = (HttpURLConnection) url.openConnection();
                connection.setConnectTimeout(15000); connection.setReadTimeout(20000);
                connection.setRequestMethod("POST"); connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                byte[] body = new JSONObject().put("barcode", barcode).toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(body); }
                int code = connection.getResponseCode();
                if (code >= 200 && code < 300) show("تم إرسال: " + barcode);
                else if (code == 401 || code == 403 || code == 404 || code == 410) show("رمز الربط غير صالح أو انتهت صلاحيته. أنشئ رمزًا جديدًا من الكاشير.");
                else show("تعذر إرسال الباركود (" + code + "). حاول مرة أخرى.");
            } catch (Exception e) { show("تعذر الاتصال بالخادم. تحقق من الإنترنت وحاول مرة أخرى."); }
            finally { if (connection != null) connection.disconnect(); sending = false; }
        });
    }

    private void show(String message) { runOnUiThread(() -> { if (!destroyed) status.setText(message); }); }

    @Override public void onDestroy() {
        destroyed = true;
        if (cameraProvider != null) cameraProvider.unbindAll();
        if (scanner != null) scanner.close();
        cameraExecutor.shutdown(); networkExecutor.shutdown();
        super.onDestroy();
    }
}
