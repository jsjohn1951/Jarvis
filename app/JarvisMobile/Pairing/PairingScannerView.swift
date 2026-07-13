import SwiftUI
import AVFoundation

/// Camera QR scanner for the pairing code printed by scripts/ios-package.sh.
/// On success the decoded payload is handed to the caller (which applies it and
/// reconnects); scan errors just keep scanning.
struct PairingScannerView: UIViewControllerRepresentable {
    var onScan: (PairingPayload) -> Void

    func makeUIViewController(context: Context) -> ScannerViewController {
        let vc = ScannerViewController()
        vc.onCode = { code in
            if let payload = PairingPayload.decode(code) { onScan(payload) }
        }
        return vc
    }

    func updateUIViewController(_ vc: ScannerViewController, context: Context) {}
}

// @preconcurrency: the AVFoundation delegate protocol predates Swift concurrency;
// our delegate callback is delivered on .main (set below), matching the class's
// implicit main-actor isolation.
final class ScannerViewController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    private let session = AVCaptureSession()
    private var handled = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.frame = view.layer.bounds
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        handled = false
        let s = session
        DispatchQueue.global(qos: .userInitiated).async { if !s.isRunning { s.startRunning() } }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let s = session
        DispatchQueue.global(qos: .userInitiated).async { if s.isRunning { s.stopRunning() } }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput,
                        didOutput objects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard !handled,
              let qr = objects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first,
              qr.type == .qr, let code = qr.stringValue else { return }
        handled = true
        onCode?(code)
    }
}
