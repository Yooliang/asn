package tw.yooliang.asn

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ExportPathTest {
  @get:Rule val tmp = TemporaryFolder()

  private lateinit var filesRoot: File
  private lateinit var root: File

  @Before fun setUp() {
    filesRoot = tmp.newFolder("files").canonicalFile
    root = File(File(filesRoot, ".irori-asn"), "received")
    assertTrue(root.mkdirs())
    root = root.canonicalFile
  }

  private fun file(dir: File, name: String, text: String = "x"): File =
    File(dir, name).apply { parentFile.mkdirs(); writeText(text) }

  private fun symlinkOrSkip(link: File, target: File) {
    try {
      Files.createSymbolicLink(link.toPath(), target.toPath())
    } catch (e: Exception) {
      assumeTrue("這個環境不能建符號連結：" + e.javaClass.simpleName, false)
    }
  }

  // ---------- resolve ----------

  @Test fun regularFileAllowed() {
    val f = file(root, "a.txt")
    assertEquals(f.canonicalFile, ExportPath.resolve(root, f.path))
  }

  @Test fun regularFileInSubfolderAllowed() {
    val f = file(File(root, "sub"), "b.png")
    assertEquals(f.canonicalFile, ExportPath.resolve(root, f.path))
  }

  @Test fun parentSegmentsEscapingRootRejected() {
    val outside = file(filesRoot, "secret.bin")
    assertTrue(outside.isFile)
    val p = root.path + File.separator + ".." + File.separator + ".." + File.separator + "secret.bin"
    assertNull(ExportPath.resolve(root, p))
  }

  @Test fun parentSegmentsStayingInsideRootAllowed() {
    file(root, "a.txt")
    assertNotNull(ExportPath.resolve(root, File(File(root, "sub"), ".." + File.separator + "a.txt").path))
  }

  @Test fun symlinkPointingOutsideRejected() {
    val outside = file(filesRoot, "secret.bin")
    val link = File(root, "link.bin")
    symlinkOrSkip(link, outside)
    assertNull(ExportPath.resolve(root, link.path))
  }

  @Test fun folderSymlinkPointingOutsideRejected() {
    val outsideDir = File(filesRoot, "other").apply { mkdirs() }
    file(outsideDir, "c.txt")
    val link = File(root, "dirlink")
    symlinkOrSkip(link, outsideDir)
    assertNull(ExportPath.resolve(root, File(link, "c.txt").path))
  }

  @Test fun siblingFolderWithSamePrefixRejected() {
    val evil = File(root.parentFile, "received_evil")
    val f = file(evil, "a.txt")
    assertNull(ExportPath.resolve(root, f.path))
  }

  @Test fun folderItselfRejected() {
    assertNull(ExportPath.resolve(root, root.path))
    val sub = File(root, "sub").apply { mkdirs() }
    assertNull(ExportPath.resolve(root, sub.path))
  }

  @Test fun missingFileRejected() {
    assertNull(ExportPath.resolve(root, File(root, "nope.txt").path))
  }

  @Test fun emptyAndNulPathsRejected() {
    assertNull(ExportPath.resolve(root, ""))
    assertNull(ExportPath.resolve(root, root.path + File.separator + "a\u0000b"))
  }

  // ---------- isValidExportRoot ----------

  @Test fun expectedRootAccepted() {
    assertTrue(ExportPath.isValidExportRoot(filesRoot, root))
  }

  @Test fun dataDirAndItsParentsAreNotExportRoot() {
    assertFalse(ExportPath.isValidExportRoot(filesRoot, filesRoot))
    assertFalse(ExportPath.isValidExportRoot(filesRoot, filesRoot.parentFile))
    assertFalse(ExportPath.isValidExportRoot(filesRoot, root.parentFile))
  }

  @Test fun otherFoldersAreNotExportRoot() {
    val other = File(root.parentFile, "other").apply { mkdirs() }
    assertFalse(ExportPath.isValidExportRoot(filesRoot, other))
    assertFalse(ExportPath.isValidExportRoot(filesRoot, File(root, "sub").apply { mkdirs() }))
  }

  @Test fun receivedBeingSymlinkRejected() {
    val real = File(filesRoot, "elsewhere").apply { mkdirs() }.canonicalFile
    val dataDir = File(filesRoot, ".irori-asn")
    assertTrue(root.deleteRecursively())
    symlinkOrSkip(File(dataDir, "received"), real)
    assertFalse(ExportPath.isValidExportRoot(filesRoot, File(dataDir, "received").canonicalFile))
  }

  @Test fun dataDirBeingSymlinkRejected() {
    val real = tmp.newFolder("realdata").canonicalFile
    File(real, "received").mkdirs()
    assertTrue(File(filesRoot, ".irori-asn").deleteRecursively())
    symlinkOrSkip(File(filesRoot, ".irori-asn"), real)
    val r = File(File(filesRoot, ".irori-asn"), "received").canonicalFile
    assertFalse(ExportPath.isValidExportRoot(filesRoot, r))
  }

  @Test fun missingRootJudgedByLocationOnly() {
    assertTrue(root.deleteRecursively())
    assertTrue(ExportPath.isValidExportRoot(filesRoot, root))
    assertNull(ExportPath.resolve(root, File(root, "a.txt").path))
  }

  // ---------- sameRegularFile ----------

  private fun id(dev: Long, ino: Long, reg: Boolean = true) = ExportPath.FileId(dev, ino, reg)

  @Test fun sameDeviceAndInodeAccepted() {
    assertTrue(ExportPath.sameRegularFile(id(1, 42), id(1, 42)))
  }

  @Test fun differentInodeRejected() {
    assertFalse(ExportPath.sameRegularFile(id(1, 42), id(1, 43)))
  }

  @Test fun differentDeviceRejected() {
    assertFalse(ExportPath.sameRegularFile(id(1, 42), id(2, 42)))
  }

  @Test fun eitherSideNotRegularRejected() {
    assertFalse(ExportPath.sameRegularFile(id(1, 42, false), id(1, 42)))
    assertFalse(ExportPath.sameRegularFile(id(1, 42), id(1, 42, false)))
    assertFalse(ExportPath.sameRegularFile(id(1, 42, false), id(1, 42, false)))
  }
}
